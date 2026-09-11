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
  noParentOwners: boolean
}

export interface OwnersSet {
  approvers: Set<string>
  reviewers: Set<string>
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
    noParentOwners,
  }
}

function roleList(
  path: string,
  doc: Record<string, unknown>,
  role: OwnersRole,
): string[] {
  const value = doc[role]
  if (value === undefined || value === null) {
    return []
  }

  if (!Array.isArray(value) || !value.every(v => typeof v === 'string')) {
    throw new Error(
      `OWNERS at ${path}: ${role} must be a list of GitHub usernames`,
    )
  }

  return value.map(v => v.toLowerCase())
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
 * options.no_parent_owners stops the walk.
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
  const sources: string[] = []

  let dir = ownersDir(file)
  for (;;) {
    const found = owners.get(dir)
    if (found !== undefined) {
      found.approvers.forEach(a => approvers.add(a))
      found.reviewers.forEach(r => reviewers.add(r))
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

  return { approvers, reviewers, sources }
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

/**
 * Load the OWNERS files at ref that can apply to the given paths.
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
    const response = await octokit.git.getTree({
      ...context.repo,
      tree_sha: ref,
      recursive: 'true',
    })
    tree = response.data
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
      if (typeof e === 'object' && e && 'status' in e && e.status === 404) {
        continue
      }
      throw new Error(`error loading OWNERS files at ${ref}: ${e}`)
    }

    owners.set(dir, parseOwners(path, decode(data, path)))
  }

  return { owners, hasOwners: owners.size > 0 }
}
