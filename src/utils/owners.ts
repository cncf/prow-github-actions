import type { Octokit } from '@octokit/rest'
import type { Context } from './context'
import * as yaml from 'js-yaml'

import { platform } from '../platform'
import { decodeContent } from './base64'

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
    platform().log.debug(`OWNERS at ${path}: filters are not supported; ignoring`)
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
 * Parse an `@org/team-slug` entry of an approvers or reviewers list.
 *
 * @param entry - a lowercased OWNERS entry
 * @returns undefined when the entry is a plain login
 */
export function parseGroup(entry: string): { org: string, slug: string } | undefined {
  const match = /^@([^/\s]+)\/([^/\s]+)$/.exec(entry)
  return match === null ? undefined : { org: match[1]!, slug: match[2]! }
}

const groupCache = new Map<string, Promise<string[]>>()
// entries already warned about: the same OWNERS entry is expanded once per changed file per role
const warnedEntries = new Set<string>()

function warnOnce(entry: string, message: string): void {
  if (!warnedEntries.has(entry)) {
    warnedEntries.add(entry)
    platform().log.warning(message)
  }
}

/**
 * Replace the `@org/team` entries of a list of OWNERS entries with the logins of
 * the team's members (transitive, as the teams API returns them). A group of
 * another organization, one that cannot be read, or a malformed `@…` entry
 * contributes nobody and is warned about once per run.
 *
 * @param octokit - a hydrated github client
 * @param context - the github actions event context
 * @param entries - lowercased OWNERS entries
 */
export async function expandGroups(
  octokit: Octokit,
  context: Context,
  entries: Iterable<string>,
): Promise<Set<string>> {
  const result = new Set<string>()
  const owner = context.repo.owner.toLowerCase()
  const groups = new Set<string>()
  for (const entry of entries) {
    const group = parseGroup(entry)
    if (group !== undefined) {
      if (group.org === owner) {
        groups.add(group.slug)
      }
      else {
        warnOnce(entry, `OWNERS: ignoring group ${entry}: only groups of ${owner} are supported`)
      }
    }
    else if (entry.startsWith('@')) {
      warnOnce(entry, `OWNERS: ignoring ${entry}: a group is written @<org>/<team-slug>`)
    }
    else {
      result.add(entry)
    }
  }

  const members = await Promise.all([...groups].map(slug =>
    memoized(groupCache, `${owner}/${slug}`, async () => {
      try {
        const listed = await octokit.paginate(octokit.teams.listMembersInOrg, {
          org: context.repo.owner,
          team_slug: slug,
          per_page: 100,
        })
        return listed.map(member => member.login.toLowerCase())
      }
      catch (e) {
        platform().log.warning(`OWNERS: could not read the members of @${owner}/${slug}: ${e}`)
        return []
      }
    })))
  members.flat().forEach(login => result.add(login))
  return result
}

/**
 * Whether a list of OWNERS entries names a login, directly or through one of
 * its groups. A direct listing answers without reading any team.
 *
 * @param octokit - a hydrated github client
 * @param context - the github actions event context
 * @param entries - lowercased OWNERS entries
 * @param login - a lowercased login
 */
export async function ownersInclude(
  octokit: Octokit,
  context: Context,
  entries: Iterable<string>,
  login: string,
): Promise<boolean> {
  const list = [...entries]
  if (list.includes(login)) {
    return true
  }
  return (await expandGroups(octokit, context, list)).has(login)
}

/** an OwnersSet whose approvers and reviewers hold logins only */
export async function expandOwnersSet(
  octokit: Octokit,
  context: Context,
  set: OwnersSet | undefined,
): Promise<OwnersSet | undefined> {
  if (set === undefined) {
    return undefined
  }
  const [approvers, reviewers] = await Promise.all([
    expandGroups(octokit, context, set.approvers),
    expandGroups(octokit, context, set.reviewers),
  ])
  return { ...set, approvers, reviewers }
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
  if (file.content === undefined || !file.encoding) {
    throw new Error(`invalid OWNERS file returned from GitHub API for ${path}`)
  }
  return decodeContent(file.content, file.encoding)
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
    platform().log.debug(`tree at ${ref} is truncated; probing for OWNERS files`)
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

/* v8 ignore start -- test-only hook, never reached from dist/index.js */
export function resetOwnersCaches(): void {
  hasOwnersCache.clear()
  treeCache.clear()
  groupCache.clear()
  warnedEntries.clear()
}
/* v8 ignore stop */

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
      platform().log.debug(`no tree at ${branch}: treating the repository as having no OWNERS files`)
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
