import type { Octokit } from '@octokit/rest'
import type { Context } from './context'
import * as yaml from 'js-yaml'

import { platform } from '../platform'
import { decodeContent } from './base64'

export type OwnersRole = 'approvers' | 'reviewers'

export type OwnersAliases = Map<string, string[]>

const ownersAliasesPath = 'OWNERS_ALIASES'

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
  aliases: OwnersAliases
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
 * Parse the contents of a root OWNERS_ALIASES file. Alias names and member
 * logins are lowercased because GitHub logins are case-insensitive.
 *
 * @param contents - the yaml contents
 */
export function parseOwnersAliases(contents: string): OwnersAliases {
  // a comment-only file holds zero documents, which yaml.load rejects; more than one is refused as yaml.load does
  const documents: unknown[] = yaml.loadAll(contents)
  if (documents.length > 1) {
    throw new yaml.YAMLException('expected a single document in the stream, but found more')
  }
  const loaded = documents[0]
  const doc: Record<string, unknown>
    = typeof loaded === 'object' && loaded !== null && !Array.isArray(loaded)
      ? (loaded as Record<string, unknown>)
      : {}

  const raw = doc.aliases
  if (raw === undefined || raw === null) {
    return new Map()
  }

  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TypeError(`${ownersAliasesPath}: aliases must be a mapping of alias names to lists of GitHub usernames`)
  }

  const aliases: OwnersAliases = new Map()
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value === null) {
      aliases.set(name.toLowerCase(), [])
      continue
    }
    if (!Array.isArray(value) || !value.every(v => typeof v === 'string')) {
      throw new Error(`${ownersAliasesPath}: alias ${name} must be a list of GitHub usernames`)
    }
    aliases.set(name.toLowerCase(), value.map(v => v.toLowerCase()))
  }
  return aliases
}

/**
 * Replace each non-`@` entry that matches an OWNERS_ALIASES key with that
 * alias's members (single-level, matching Prow's RepoAliases.ExpandAliases).
 * Entries not in `aliases`, and entries starting with `@`, pass through unchanged.
 *
 * @param entries - lowercased OWNERS entries
 * @param aliases - lowercased alias map from OWNERS_ALIASES
 */
export function expandAliases(
  entries: Iterable<string>,
  aliases: OwnersAliases,
): string[] {
  const result: string[] = []
  for (const entry of entries) {
    if (!entry.startsWith('@')) {
      const members = aliases.get(entry)
      if (members !== undefined) {
        result.push(...members)
        continue
      }
    }
    result.push(entry)
  }
  return result
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

// the same OWNERS entry is expanded once per changed file per role; warn about it once per run
function warnOnce(entry: string, message: string): void {
  const warnedEntries = platform().state().ownerWarnings
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
    memoized(platform().state().ownerGroups, `${owner}/${slug}`, async () => {
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
 * Whether a list of OWNERS entries names a login, directly, through an
 * OWNERS_ALIASES entry, or through a GitHub group. Entries that are all `@…`
 * groups skip reading OWNERS_ALIASES; a login matched directly or through an
 * alias answers without reading any team.
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
  let expanded = list
  if (list.some(entry => !entry.startsWith('@'))) {
    expanded = expandAliases(list, await probeOwnersAliases(octokit, context))
    if (expanded.includes(login)) {
      return true
    }
  }
  return (await expandGroups(octokit, context, expanded)).has(login)
}

/** an OwnersSet whose approvers and reviewers hold logins only */
export async function expandOwnersSet(
  octokit: Octokit,
  context: Context,
  set: OwnersSet | undefined,
  aliases: OwnersAliases,
): Promise<OwnersSet | undefined> {
  if (set === undefined) {
    return undefined
  }
  const [approvers, reviewers] = await Promise.all([
    expandGroups(octokit, context, expandAliases(set.approvers, aliases)),
    expandGroups(octokit, context, expandAliases(set.reviewers, aliases)),
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

/**
 * Load the OWNERS files at ref that can apply to the given paths. The
 * recursive listing of a commit never changes, so it is memoized per ref for
 * the duration of the run: pull requests sharing a base tip share it.
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
    tree = await memoized(platform().state().trees as Map<string, Promise<TreeListing>>, `${context.repo.owner}/${context.repo.repo}@${ref}`, async () =>
      (await octokit.git.getTree({ ...context.repo, tree_sha: ref, recursive: 'true' })).data)
  }
  catch (e) {
    throw new Error(`error loading OWNERS files at ${ref}: ${e}`)
  }

  if (tree.truncated) {
    // a truncated listing may have dropped OWNERS entries, so ask for each candidate path directly
    platform().log.debug(`tree at ${ref} is truncated; probing for OWNERS files`)
    return probeOwners(octokit, context, ref, dirs, listedOwners(tree).length > 0)
  }

  const entries = listedOwners(tree)

  const wanted = entries.filter(entry => dirs.has(ownersDir(entry.path)))
  const aliasesEntry = wanted.length > 0 ? findAliasesBlob(tree) : undefined

  try {
    const [files, aliases] = await Promise.all([
      Promise.all(
        wanted.map(async (entry) => {
          const blob = await octokit.git.getBlob({
            ...context.repo,
            file_sha: entry.sha,
          })
          return parseOwners(entry.path, decode(blob.data, entry.path))
        }),
      ),
      aliasesEntry === undefined
        ? Promise.resolve(new Map<string, string[]>())
        : loadAliasesBlob(octokit, context, ref, aliasesEntry.sha),
    ])

    return {
      owners: new Map(files.map(file => [ownersDir(file.path), file])),
      aliases,
      hasOwners: entries.length > 0,
    }
  }
  catch (e) {
    throw new Error(`error loading OWNERS files at ${ref}: ${e}`)
  }
}

function listedOwners(tree: TreeListing): { path: string, sha: string }[] {
  return tree.tree.filter(
    entry =>
      entry.type === 'blob'
      && entry.path !== undefined
      && entry.sha !== undefined
      && isOwnersPath(entry.path),
  ) as { path: string, sha: string }[]
}

function findAliasesBlob(tree: TreeListing): { sha: string } | undefined {
  return tree.tree.find(
    entry =>
      entry.type === 'blob'
      && entry.path === ownersAliasesPath
      && entry.sha !== undefined,
  ) as { sha: string } | undefined
}

function loadAliasesBlob(
  octokit: Octokit,
  context: Context,
  ref: string,
  sha: string,
): Promise<OwnersAliases> {
  return memoized(
    platform().state().ownerAliases as Map<string, Promise<OwnersAliases>>,
    `${context.repo.owner}/${context.repo.repo}@${ref}`,
    async () => {
      const blob = await octokit.git.getBlob({
        ...context.repo,
        file_sha: sha,
      })
      return parseOwnersAliases(decode(blob.data, ownersAliasesPath))
    },
  )
}

/**
 * probeOwners reads the OWNERS file of each directory in dirs through the
 * contents API, for a tree listing GitHub truncated. The ref has OWNERS files
 * when a probe finds one (the root is always probed) or when the partial
 * listing names one elsewhere, the same answer `branchHasOwners` gives, so
 * that an OWNERS file outside the changed paths' ancestors keeps the OWNERS
 * rules on whether or not the listing was truncated.
 */
async function probeOwners(
  octokit: Octokit,
  context: Context,
  ref: string,
  dirs: Set<string>,
  listed: boolean,
): Promise<OwnersTree> {
  // every candidate directory at once; a missing OWNERS file is just absent
  const found = await Promise.all([...dirs].map(async (dir): Promise<[string, OwnersFile] | undefined> => {
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
        return undefined
      }
      throw new Error(`error loading OWNERS files at ${ref}: ${e}`)
    }

    return [dir, parseOwners(path, decode(data, path))]
  }))

  const owners = new Map(found.filter(entry => entry !== undefined))
  const aliases = owners.size > 0
    ? await probeOwnersAliases(octokit, context, ref)
    : new Map<string, string[]>()
  return { owners, aliases, hasOwners: listed || owners.size > 0 }
}

function probeOwnersAliases(
  octokit: Octokit,
  context: Context,
  ref?: string,
): Promise<OwnersAliases> {
  const [key, where] = ref === undefined
    ? [`${context.repo.owner}/${context.repo.repo}`, '']
    : [`${context.repo.owner}/${context.repo.repo}@${ref}`, ` at ${ref}`]
  return memoized(
    platform().state().ownerAliases as Map<string, Promise<OwnersAliases>>,
    key,
    async () => {
      let data
      try {
        const response = await octokit.repos.getContent({
          ...context.repo,
          path: ownersAliasesPath,
          ref,
        })
        data = response.data
      }
      catch (e) {
        if (isNotFound(e)) {
          return new Map()
        }
        throw new Error(`error loading OWNERS files${where}: ${e}`)
      }

      return parseOwnersAliases(decode(data, ownersAliasesPath))
    },
  )
}

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
  return memoized(platform().state().hasOwners, `${context.repo.owner}/${context.repo.repo}`, async () =>
    branchHasOwners(octokit, context, await defaultBranch(octokit, context)))
}

/**
 * branchHasOwners reports whether a branch carries any OWNERS file, which is
 * what switches `/approve` and the tide gate to their OWNERS behaviour. One
 * recursive tree listing per branch, memoized for the duration of the run.
 *
 * @param octokit - a hydrated github client
 * @param context - the github actions event context
 * @param branch - the branch name, ex: the pull request's `base.ref`
 */
export function branchHasOwners(octokit: Octokit, context: Context, branch: string): Promise<boolean> {
  return memoized(platform().state().hasOwners, `${context.repo.owner}/${context.repo.repo}@${branch}`, () =>
    probeBranchOwners(octokit, context, branch))
}

/** memoized returns the cached promise for `key`, computing it on first use */
export function memoized<T>(cache: Map<string, Promise<T>>, key: string, compute: () => Promise<T>): Promise<T> {
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
