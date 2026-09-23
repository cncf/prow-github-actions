import type { Octokit } from '@octokit/rest'
import type { Context } from './context'
import { Buffer } from 'node:buffer'

import * as core from '@actions/core'
import * as yaml from 'js-yaml'

export type OwnersRole = 'approvers' | 'reviewers'

export interface OwnersFile {
  path: string
  approvers: string[]
  reviewers: string[]
  /** labels the owners-label plugin applies to a PR touching this directory */
  labels: string[]
  noParentOwners: boolean
}

export interface OwnersSet {
  approvers: Set<string>
  reviewers: Set<string>
  labels: Set<string>
  sources: string[]
}

export interface OwnersTree {
  owners: Map<string, OwnersFile>
  hasOwners: boolean
}

/**
 * Parse the contents of an OWNERS file. Logins are lowercased because GitHub
 * logins are case-insensitive.
 *
 * @param path - the path of the OWNERS file, used in error messages
 * @param contents - the yaml contents
 */
export function parseOwners(path: string, contents: string): OwnersFile {
  const loaded: unknown = contents.trim() === '' ? {} : yaml.load(contents)
  const doc: Record<string, unknown>
    = typeof loaded === 'object' && loaded !== null && !Array.isArray(loaded)
      ? (loaded as Record<string, unknown>)
      : {}

  if ('filters' in doc) {
    core.debug(`OWNERS at ${path}: filters are not supported; ignoring`)
  }

  const options = doc.options
  const noParentOwners
    = typeof options === 'object'
      && options !== null
      && (options as Record<string, unknown>).no_parent_owners === true

  return {
    path,
    approvers: roleList(path, doc, 'approvers'),
    reviewers: roleList(path, doc, 'reviewers'),
    labels: stringList(path, doc, 'labels', 'label names'),
    noParentOwners,
  }
}

function roleList(
  path: string,
  doc: Record<string, unknown>,
  role: OwnersRole,
): string[] {
  return stringList(path, doc, role, 'GitHub usernames').map(v => v.toLowerCase())
}

function stringList(
  path: string,
  doc: Record<string, unknown>,
  key: string,
  what: string,
): string[] {
  const value = doc[key]
  if (value === undefined || value === null) {
    return []
  }

  if (!Array.isArray(value) || !value.every(v => typeof v === 'string')) {
    throw new Error(
      `OWNERS at ${path}: ${key} must be a list of ${what}`,
    )
  }

  return value
}

/**
 * The directory that contains a path: 'sdk/OWNERS' is 'sdk', 'OWNERS' is ''
 *
 * @param path - a repository relative path
 */
export function ownersDir(path: string): string {
  const slash = path.lastIndexOf('/')
  return slash === -1 ? '' : path.slice(0, slash)
}

/**
 * Resolve the OWNERS that apply to a file: walk from its directory up to the
 * root, taking the union of every OWNERS file on the way. A file with
 * options.no_parent_owners stops the walk. Labels union along the walk too,
 * where Prow's owners-label uses only the deepest file's labels.
 *
 * @param file - the changed file
 * @param owners - OWNERS files keyed by directory
 * @returns undefined when no OWNERS file covers the file
 */
export function effectiveOwners(
  file: string,
  owners: Map<string, OwnersFile>,
): OwnersSet | undefined {
  const approvers = new Set<string>()
  const reviewers = new Set<string>()
  const labels = new Set<string>()
  const sources: string[] = []

  let dir = ownersDir(file)
  for (;;) {
    const found = owners.get(dir)
    if (found !== undefined) {
      found.approvers.forEach(a => approvers.add(a))
      found.reviewers.forEach(r => reviewers.add(r))
      found.labels.forEach(l => labels.add(l))
      sources.push(found.path)
      if (found.noParentOwners) {
        break
      }
    }

    if (dir === '') {
      break
    }
    dir = ownersDir(dir)
  }

  if (sources.length === 0) {
    return undefined
  }

  return { approvers, reviewers, labels, sources }
}

function ancestorDirs(paths: string[]): Set<string> {
  const dirs = new Set<string>([''])
  for (const path of paths) {
    for (let dir = ownersDir(path); dir !== ''; dir = ownersDir(dir)) {
      dirs.add(dir)
    }
  }
  return dirs
}

function isOwnersPath(path: string): boolean {
  return path === 'OWNERS' || path.endsWith('/OWNERS')
}

function decode(data: unknown, path: string): string {
  const file = data as { content?: string, encoding?: string }
  if (!file.content || !file.encoding) {
    throw new Error(`invalid OWNERS file returned from GitHub API for ${path}`)
  }
  return Buffer.from(file.content, file.encoding as BufferEncoding).toString()
}

type TreeListing = Awaited<ReturnType<Octokit['git']['getTree']>>['data']

const treeCache = new Map<string, Promise<TreeListing>>()

/**
 * Load the OWNERS files at ref that can apply to the given paths. The
 * recursive listing of a commit never changes, so it is memoized per ref for
 * the lifetime of the process: pull requests sharing a base tip share it.
 *
 * @param octokit - a hydrated github client
 * @param context - the github actions event context
 * @param ref - the commit to read OWNERS files from
 * @param pathsOfInterest - the changed files; only OWNERS in their ancestor directories are fetched
 */
export async function loadOwnersTree(
  octokit: Octokit,
  context: Context,
  ref: string,
  pathsOfInterest: string[],
): Promise<OwnersTree> {
  const dirs = ancestorDirs(pathsOfInterest)

  let tree
  try {
    tree = await memoized(treeCache, `${context.repo.owner}/${context.repo.repo}@${ref}`, async () =>
      (await octokit.git.getTree({ ...context.repo, tree_sha: ref, recursive: 'true' })).data)
  }
  catch (e) {
    throw new Error(`error loading OWNERS files at ${ref}: ${e}`)
  }

  if (tree.truncated) {
    // a truncated listing may have dropped OWNERS entries, so ask for each candidate path directly
    core.debug(`tree at ${ref} is truncated; probing for OWNERS files`)
    return probeOwners(octokit, context, ref, dirs)
  }

  const entries = tree.tree.filter(
    entry =>
      entry.type === 'blob'
      && entry.path !== undefined
      && entry.sha !== undefined
      && isOwnersPath(entry.path),
  ) as { path: string, sha: string }[]

  const wanted = entries.filter(entry => dirs.has(ownersDir(entry.path)))

  let files: OwnersFile[]
  try {
    files = await Promise.all(
      wanted.map(async (entry) => {
        const blob = await octokit.git.getBlob({
          ...context.repo,
          file_sha: entry.sha,
        })
        return parseOwners(entry.path, decode(blob.data, entry.path))
      }),
    )
  }
  catch (e) {
    throw new Error(`error loading OWNERS files at ${ref}: ${e}`)
  }

  return {
    owners: new Map(files.map(file => [ownersDir(file.path), file])),
    hasOwners: entries.length > 0,
  }
}

async function probeOwners(
  octokit: Octokit,
  context: Context,
  ref: string,
  dirs: Set<string>,
): Promise<OwnersTree> {
  const owners = new Map<string, OwnersFile>()

  for (const dir of dirs) {
    const path = dir === '' ? 'OWNERS' : `${dir}/OWNERS`
    let data
    try {
      const response = await octokit.repos.getContent({
        ...context.repo,
        path,
        ref,
      })
      data = response.data
    }
    catch (e) {
      if (isNotFound(e)) {
        continue
      }
      throw new Error(`error loading OWNERS files at ${ref}: ${e}`)
    }

    owners.set(dir, parseOwners(path, decode(data, path)))
  }

  return { owners, hasOwners: owners.size > 0 }
}

const hasOwnersCache = new Map<string, Promise<boolean>>()

/**
 * repoHasOwners reports whether the default branch carries any OWNERS file.
 * It is `branchHasOwners` for the default branch, which the payload's
 * `repository.default_branch` names without a `repos.get` lookup. Callers
 * with a pull request in scope use `branchHasOwners` on its base branch, so
 * that the tide gate and `/approve` read the same ref.
 *
 * @param octokit - a hydrated github client
 * @param context - the github actions event context
 */
export function repoHasOwners(octokit: Octokit, context: Context): Promise<boolean> {
  return memoized(hasOwnersCache, `${context.repo.owner}/${context.repo.repo}`, async () =>
    branchHasOwners(octokit, context, await defaultBranch(octokit, context)))
}

/**
 * branchHasOwners reports whether a branch carries any OWNERS file, which is
 * what switches `/approve` and the tide gate to their OWNERS behaviour. One
 * recursive tree listing per branch, memoized for the lifetime of the process.
 *
 * @param octokit - a hydrated github client
 * @param context - the github actions event context
 * @param branch - the branch name, ex: the pull request's `base.ref`
 */
export function branchHasOwners(octokit: Octokit, context: Context, branch: string): Promise<boolean> {
  return memoized(hasOwnersCache, `${context.repo.owner}/${context.repo.repo}@${branch}`, () =>
    probeBranchOwners(octokit, context, branch))
}

export function resetOwnersCaches(): void {
  hasOwnersCache.clear()
  treeCache.clear()
}

function memoized<T>(cache: Map<string, Promise<T>>, key: string, compute: () => Promise<T>): Promise<T> {
  let pending = cache.get(key)
  if (pending === undefined) {
    pending = compute()
    cache.set(key, pending)
  }
  return pending
}

async function probeBranchOwners(octokit: Octokit, context: Context, branch: string): Promise<boolean> {
  let tree
  try {
    tree = (await octokit.git.getTree({ ...context.repo, tree_sha: branch, recursive: 'true' })).data
  }
  catch (e) {
    if (isNotFound(e)) {
      core.debug(`no tree at ${branch}: treating the repository as having no OWNERS files`)
      return false
    }
    throw new Error(`error listing the tree of ${branch}: ${e}`)
  }

  if (tree.tree.some(entry => entry.type === 'blob' && entry.path !== undefined && isOwnersPath(entry.path))) {
    return true
  }
  if (!tree.truncated) {
    return false
  }

  // a truncated listing may have dropped every OWNERS entry; the root file is the one Prow requires anyway
  try {
    await octokit.repos.getContent({ ...context.repo, path: 'OWNERS', ref: branch })
    return true
  }
  catch (e) {
    if (isNotFound(e)) {
      return false
    }
    throw new Error(`error probing for a root OWNERS file at ${branch}: ${e}`)
  }
}

async function defaultBranch(octokit: Octokit, context: Context): Promise<string> {
  const fromPayload: unknown = context.payload.repository?.default_branch
  if (typeof fromPayload === 'string' && fromPayload !== '') {
    return fromPayload
  }

  try {
    return (await octokit.repos.get({ ...context.repo })).data.default_branch
  }
  catch (e) {
    throw new Error(`could not read the default branch: ${e}`)
  }
}

function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'status' in error && error.status === 404
}
