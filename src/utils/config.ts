import type { Octokit } from '@octokit/rest'
import type { Context } from './context'
import { Buffer } from 'node:buffer'
import * as core from '@actions/core'
import * as yaml from 'js-yaml'

import { parseDuration } from './duration'

/** one allowed value of a label section, optionally with GitHub label metadata */
export interface LabelValue {
  name: string
  /** six hex digits without the leading '#' */
  color?: string
  description?: string
}

/** one label family, ex: the `kind` key */
export interface LabelSection {
  /** the allowed values, ex: ['bug', 'cleanup'] */
  values: string[]
  /** replace any existing '<prefix>/*' labels instead of stacking them */
  exclusive?: boolean
  /** the values with their color and description; a plain string is `{ name }` */
  definitions: LabelValue[]
}

export interface RequireMatchingLabel {
  regexp: string
  missing_label: string
  issues?: boolean
  prs?: boolean
  missing_comment?: string
  grace_period_duration?: string
}

export type MergeMethod = 'merge' | 'squash' | 'rebase'

/** `auto`: detect a required merge queue per pull request and enqueue instead of merging; `off`: always `PUT /merge` */
export type MergeQueueMode = 'auto' | 'off'

export interface TideConfig {
  labels?: string[]
  missing_labels?: string[]
  merge_method?: MergeMethod
  /** evaluate and merge on pull_request, pull_request_review and check_suite events; default true */
  merge_on_events?: boolean
  /** default `auto` */
  merge_queue?: MergeQueueMode
}

/** TideConfig with every default applied, see resolveTide */
export interface ResolvedTide {
  labels: string[]
  missing_labels: string[]
  merge_method: MergeMethod
  merge_on_events: boolean
  merge_queue: MergeQueueMode
}

export interface HoldConfig {
  label?: string
}

export interface BlunderbussConfig {
  /** reviewers to request per pull request; default 2 */
  request_count?: number
  /** never leave the pull request with more requested reviewers than this */
  max_request_count?: number
  /** only consider `reviewers`, not `approvers`; default false */
  exclude_approvers?: boolean
  /** wait for `ready_for_review` on drafts; default true */
  ignore_drafts?: boolean
  /** pull request authors that never get reviewers assigned */
  ignore_authors?: string[]
}

export interface ApproveConfig {
  /** the author never counts as an approver of their own pull request; default false */
  require_self_approval?: boolean
  /** GitHub reviews neither add nor remove approvers; default false */
  ignore_review_state?: boolean
  /** `/lgtm` counts as `/approve`; default false */
  lgtm_acts_as_approve?: boolean
}

export interface LgtmConfig {
  /** record the head commit `/lgtm` reviewed as a `prow/lgtm` commit status and merge only while the head still carries it; default true */
  bind_to_commit?: boolean
}

export interface SweepConfig {
  /** how far back `updated_at` may be for a pull request to be evaluated by the `sweep` job, ex: `1h`; default 1h, capped at 24h */
  lookback?: string
}

export interface ProwConfig {
  labels: Record<string, LabelSection>
  require_matching_label: RequireMatchingLabel[]
  tide: TideConfig
  hold: HoldConfig
  blunderbuss: BlunderbussConfig
  approve: ApproveConfig
  lgtm: LgtmConfig
  sweep: SweepConfig
  /** every file that contributed, lowest precedence first, as `owner/repo:path` or a url */
  sources: string[]
}

const mergeMethods = ['merge', 'squash', 'rebase'] as const
const mergeQueueModes = ['auto', 'off'] as const
const colorPattern = /^[0-9a-f]{6}$/i

export const defaultHoldLabel = 'do-not-merge/hold'
export const defaultTideLabels = ['lgtm']
/** the `tide.labels` default of a repository with OWNERS files, where the approve plugin manages `approved` */
export const defaultOwnersTideLabels = ['lgtm', 'approved']
// `hold` stays in the deny-list while repositories still carry the pre-do-not-merge/hold label
export const defaultTideMissingLabels = ['do-not-merge/*', 'needs-rebase', 'hold']

// top level keys of the new form other than `labels`
const reservedKeys = ['require_matching_label', 'tide', 'hold', 'blunderbuss', 'approve', 'lgtm', 'sweep'] as const

export const defaultSweepLookback = '1h'
export const maxSweepLookbackMs = 24 * 3_600_000

/** repositories of the owner that may hold an organization wide prow.yaml, in precedence order */
export const orgConfigRepos = ['.project', '.github']
export const orgConfigPath = 'prow.yaml'

/** paths probed in the event repository, in precedence order */
export const repoConfigPaths = [
  '.github/prow.yaml',
  '.github/prowlabels.yaml',
  'prow.yaml',
  '.prowlabels.yaml',
  '.github/prow.yml',
  '.github/prowlabels.yml',
  'prow.yml',
  '.prowlabels.yml',
]

const explicitSourcePattern = /^([^/\s:@]+)\/([^/\s:@]+):([^@\s]+)(?:@(\S+))?$/

interface Tier {
  source: string
  config: Partial<ProwConfig>
}

const cache = new Map<string, Promise<ProwConfig>>()

/**
 * loadProwConfig resolves the configuration that applies to the event
 * repository: an organization tier (`<owner>/.project` then `<owner>/.github`,
 * `prow.yaml`) or, when the `config` input is set, that explicit source
 * instead; then the repository's own file layered on top. The result is
 * memoized per repository for the lifetime of the process.
 *
 * @param octokit - a hydrated github client
 * @param context - the github actions event context
 */
export function loadProwConfig(octokit: Octokit, context: Context): Promise<ProwConfig> {
  const key = `${context.repo.owner}/${context.repo.repo}`
  let pending = cache.get(key)
  if (pending === undefined) {
    pending = load(octokit, context)
    cache.set(key, pending)
  }
  return pending
}

export function resetProwConfigCache(): void {
  cache.clear()
}

async function load(octokit: Octokit, context: Context): Promise<ProwConfig> {
  const explicit = core.getInput('config', { required: false }).trim()

  // the org and repo tiers do not depend on each other, so probe both at once
  const [base, repo] = await Promise.all([
    explicit === '' ? loadOrgTier(octokit, context) : loadExplicitTier(octokit, explicit),
    loadRepoTier(octokit, context),
  ])

  const tiers = [base, repo].filter((tier): tier is Tier => tier !== undefined)
  const merged = tiers.reduce<Partial<ProwConfig>>((acc, tier) => mergeProwConfig(acc, tier.config), {})
  const sources = tiers.map(tier => tier.source)

  core.debug(sources.length === 0 ? 'no prow configuration found' : `prow configuration loaded from ${sources.join(', ')}`)

  return { ...mergeProwConfig({}, merged), sources }
}

async function loadOrgTier(octokit: Octokit, context: Context): Promise<Tier | undefined> {
  const { owner } = context.repo

  // the event repository is the org config repo itself: its file is the repo tier
  for (const repo of orgConfigRepos.filter(repo => repo !== context.repo.repo)) {
    const source = `${owner}/${repo}:${orgConfigPath}`
    let text: string | undefined
    try {
      text = await fetchRepoFile(octokit, { owner, repo, path: orgConfigPath })
    }
    catch (e) {
      throw new Error(`could not load organization prow config from ${source}: ${e}`)
    }

    if (text !== undefined) {
      return { source, config: parseProwConfig(source, text) }
    }
  }

  return undefined
}

async function loadRepoTier(octokit: Octokit, context: Context): Promise<Tier | undefined> {
  for (const path of repoConfigPaths) {
    const source = `${context.repo.owner}/${context.repo.repo}:${path}`
    let text: string | undefined
    try {
      text = await fetchRepoFile(octokit, { ...context.repo, path })
    }
    catch (e) {
      throw new Error(`could not load prow config from ${source}: ${e}`)
    }

    if (text !== undefined) {
      return { source, config: parseProwConfig(source, text) }
    }
  }

  return undefined
}

async function loadExplicitTier(octokit: Octokit, input: string): Promise<Tier> {
  if (input.startsWith('http://')) {
    throw new Error('config: http:// sources are not allowed, use https://')
  }

  if (input.startsWith('https://')) {
    return { source: input, config: parseProwConfig(input, await fetchUrl(input)) }
  }

  const match = explicitSourcePattern.exec(input)
  if (match === null) {
    throw new Error(`config: expected owner/repo:path[@ref] or an https:// url, got '${input}'`)
  }

  const [, owner, repo, path, ref] = match
  let text: string | undefined
  try {
    text = await fetchRepoFile(octokit, { owner, repo, path, ref })
  }
  catch (e) {
    throw new Error(`could not load prow config from ${input}: ${e}`)
  }
  if (text === undefined) {
    throw new Error(`could not load prow config from ${input}: not found`)
  }

  return { source: input, config: parseProwConfig(input, text) }
}

// resolves to undefined when the repository or the file does not exist
async function fetchRepoFile(
  octokit: Octokit,
  file: { owner: string, repo: string, path: string, ref?: string },
): Promise<string | undefined> {
  let data: unknown
  try {
    data = (await octokit.repos.getContent(file)).data
  }
  catch (e) {
    if (isNotFound(e)) {
      return undefined
    }
    throw e
  }

  if (!isMapping(data) || typeof data.content !== 'string' || typeof data.encoding !== 'string') {
    throw new TypeError(`${file.path} is not a file`)
  }

  return Buffer.from(data.content, data.encoding as BufferEncoding).toString()
}

async function fetchUrl(url: string): Promise<string> {
  let response: Response
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(5000) })
  }
  catch (e) {
    throw new Error(`could not load prow config from ${url}: ${e}`)
  }

  if (!response.ok) {
    throw new Error(`could not load prow config from ${url}: HTTP ${response.status}`)
  }

  return response.text()
}

function isNotFound(error: unknown): boolean {
  return isMapping(error) && error.status === 404
}

/**
 * parseProwConfig parses one prow.yaml (or legacy .prowlabels.yaml) document.
 *
 * Both forms share one file. Legacy documents are a flat map of label
 * sections, and one of those sections is commonly named `labels` (the /label
 * allowlist, a plain list). So: a top level `labels` that is a *mapping* marks
 * the new form, where `require_matching_label`, `tide`, `hold`, `blunderbuss`,
 * `approve`, `lgtm` and `sweep` may sit alongside it and the /label allowlist is the section `labels.labels`. A
 * document without `labels` that carries one of those reserved keys is also
 * the new form. Anything else is a legacy document and every key must be a
 * label section.
 *
 * @param source - where the document came from, used in error messages only
 * @param text - the yaml text
 */
export function parseProwConfig(source: string, text: string): Partial<ProwConfig> {
  const loaded: unknown = text.trim() === '' ? undefined : yaml.load(text)

  if (loaded === undefined || loaded === null) {
    return {}
  }

  if (!isMapping(loaded)) {
    throw new Error(`${source}: yaml malformed, expected a mapping at the top level`)
  }

  const isNewForm = isMapping(loaded.labels)
    || (loaded.labels === undefined && reservedKeys.some(key => key in loaded))

  if (!isNewForm) {
    return { labels: normalizeSections(loaded) }
  }

  const config: Partial<ProwConfig> = {}

  if (loaded.labels !== undefined) {
    config.labels = normalizeSections(loaded.labels as Record<string, unknown>)
  }
  if (loaded.require_matching_label !== undefined) {
    config.require_matching_label = normalizeRequireMatchingLabel(source, loaded.require_matching_label)
  }
  if (loaded.tide !== undefined) {
    config.tide = normalizeTide(source, loaded.tide)
  }
  if (loaded.hold !== undefined) {
    config.hold = normalizeHold(source, loaded.hold)
  }
  if (loaded.blunderbuss !== undefined) {
    config.blunderbuss = normalizeBlunderbuss(source, loaded.blunderbuss)
  }
  if (loaded.approve !== undefined) {
    config.approve = normalizeApprove(source, loaded.approve)
  }
  if (loaded.lgtm !== undefined) {
    config.lgtm = normalizeLgtm(source, loaded.lgtm)
  }
  if (loaded.sweep !== undefined) {
    config.sweep = normalizeSweep(source, loaded.sweep)
  }

  const unknown = Object.keys(loaded).filter(key => key !== 'labels' && !(reservedKeys as readonly string[]).includes(key))
  if (unknown.length > 0) {
    core.debug(`${source}: ignoring unknown top level keys: ${unknown.join(', ')}`)
  }

  return config
}

function normalizeSections(sections: Record<string, unknown>): Record<string, LabelSection> {
  return Object.fromEntries(
    Object.entries(sections).map(([key, section]) => [key, normalizeSection(key, section)]),
  )
}

/**
 * normalizeSection accepts a plain list of values or a mapping
 * `{ values: [...], exclusive: bool }`; a value is a string or
 * `{ name, color?, description? }`.
 *
 * @param key - the section name, used in error messages
 * @param section - the raw yaml value
 */
export function normalizeSection(key: string, section: unknown): LabelSection {
  if (Array.isArray(section)) {
    const definitions = normalizeValues(key, section)
    return { values: definitions.map(d => d.name), definitions }
  }

  if (
    isMapping(section)
    && Array.isArray(section.values)
    && (section.exclusive === undefined || typeof section.exclusive === 'boolean')
  ) {
    const definitions = normalizeValues(key, section.values)
    return { values: definitions.map(d => d.name), exclusive: section.exclusive, definitions }
  }

  throw malformedSection(key)
}

function normalizeValues(key: string, values: unknown[]): LabelValue[] {
  return values.map((value) => {
    if (typeof value === 'string') {
      return { name: value }
    }

    if (
      isMapping(value)
      && typeof value.name === 'string'
      && (value.color === undefined || typeof value.color === 'string')
      && (value.description === undefined || typeof value.description === 'string')
    ) {
      if (value.color !== undefined && !colorPattern.test(value.color)) {
        throw new Error(`${key}: invalid color '${value.color}' for label '${value.name}', expected 6 hex digits`)
      }
      return stripUndefined({ name: value.name, color: value.color, description: value.description })
    }

    throw malformedSection(key)
  })
}

function malformedSection(key: string): Error {
  return new Error(
    `${key}: yaml malformed, expected a list of values or { values: [...], exclusive: bool }`,
  )
}

function normalizeRequireMatchingLabel(source: string, raw: unknown): RequireMatchingLabel[] {
  if (!Array.isArray(raw)) {
    throw new TypeError(`${source}: require_matching_label must be a list`)
  }

  return raw.map((entry, i) => {
    const at = `${source}: require_matching_label[${i}]`
    if (!isMapping(entry)) {
      throw new Error(`${at}: expected a mapping with regexp and missing_label`)
    }

    if (typeof entry.regexp !== 'string') {
      throw new TypeError(`${at}: regexp must be a string`)
    }
    try {
      void new RegExp(entry.regexp)
    }
    catch (e) {
      throw new Error(`${at}: regexp does not compile: ${e}`)
    }

    if (typeof entry.missing_label !== 'string' || entry.missing_label === '') {
      throw new Error(`${at}: missing_label must be a non-empty string`)
    }

    for (const flag of ['issues', 'prs'] as const) {
      if (entry[flag] !== undefined && typeof entry[flag] !== 'boolean') {
        throw new Error(`${at}: ${flag} must be a boolean`)
      }
    }
    for (const field of ['missing_comment', 'grace_period_duration'] as const) {
      if (entry[field] !== undefined && typeof entry[field] !== 'string') {
        throw new Error(`${at}: ${field} must be a string`)
      }
    }

    // like Prow's plugin, a rule that names neither applies to both
    const neither = entry.issues === undefined && entry.prs === undefined

    return stripUndefined({
      regexp: entry.regexp,
      missing_label: entry.missing_label,
      issues: neither ? true : entry.issues as boolean | undefined,
      prs: neither ? true : entry.prs as boolean | undefined,
      missing_comment: entry.missing_comment as string | undefined,
      grace_period_duration: entry.grace_period_duration as string | undefined,
    })
  })
}

function normalizeTide(source: string, raw: unknown): TideConfig {
  if (!isMapping(raw)) {
    throw new Error(`${source}: tide must be a mapping`)
  }

  for (const field of ['labels', 'missing_labels'] as const) {
    if (raw[field] !== undefined && !isLabelList(raw[field])) {
      throw new Error(`${source}: tide.${field} must be a list of label names`)
    }
  }

  if (raw.merge_method !== undefined && !(mergeMethods as readonly unknown[]).includes(raw.merge_method)) {
    throw new Error(`${source}: tide.merge_method must be one of ${mergeMethods.join(', ')}`)
  }

  if (raw.merge_on_events !== undefined && typeof raw.merge_on_events !== 'boolean') {
    throw new Error(`${source}: tide.merge_on_events must be a boolean`)
  }

  if (raw.merge_queue !== undefined && !(mergeQueueModes as readonly unknown[]).includes(raw.merge_queue)) {
    throw new Error(`${source}: tide.merge_queue must be one of ${mergeQueueModes.join(', ')}`)
  }

  return stripUndefined({
    labels: raw.labels as string[] | undefined,
    missing_labels: raw.missing_labels as string[] | undefined,
    merge_method: raw.merge_method as TideConfig['merge_method'],
    merge_on_events: raw.merge_on_events as boolean | undefined,
    merge_queue: raw.merge_queue as TideConfig['merge_queue'],
  })
}

function normalizeHold(source: string, raw: unknown): HoldConfig {
  if (!isMapping(raw)) {
    throw new Error(`${source}: hold must be a mapping`)
  }

  if (raw.label !== undefined && (typeof raw.label !== 'string' || raw.label === '')) {
    throw new Error(`${source}: hold.label must be a non-empty string`)
  }

  return stripUndefined({ label: raw.label as string | undefined })
}

function normalizeBlunderbuss(source: string, raw: unknown): BlunderbussConfig {
  if (!isMapping(raw)) {
    throw new Error(`${source}: blunderbuss must be a mapping`)
  }

  for (const field of ['request_count', 'max_request_count'] as const) {
    if (raw[field] !== undefined && !(Number.isInteger(raw[field]) && (raw[field] as number) >= 1)) {
      throw new Error(`${source}: blunderbuss.${field} must be an integer of at least 1`)
    }
  }
  if (raw.max_request_count !== undefined && (raw.max_request_count as number) < ((raw.request_count as number | undefined) ?? 1)) {
    throw new Error(`${source}: blunderbuss.max_request_count must not be lower than request_count`)
  }

  for (const field of ['exclude_approvers', 'ignore_drafts'] as const) {
    if (raw[field] !== undefined && typeof raw[field] !== 'boolean') {
      throw new Error(`${source}: blunderbuss.${field} must be a boolean`)
    }
  }

  if (raw.ignore_authors !== undefined && !isStringList(raw.ignore_authors)) {
    throw new Error(`${source}: blunderbuss.ignore_authors must be a list of GitHub usernames`)
  }

  return stripUndefined({
    request_count: raw.request_count as number | undefined,
    max_request_count: raw.max_request_count as number | undefined,
    exclude_approvers: raw.exclude_approvers as boolean | undefined,
    ignore_drafts: raw.ignore_drafts as boolean | undefined,
    ignore_authors: raw.ignore_authors as string[] | undefined,
  })
}

const approveFlags = ['require_self_approval', 'ignore_review_state', 'lgtm_acts_as_approve'] as const

function normalizeApprove(source: string, raw: unknown): ApproveConfig {
  if (!isMapping(raw)) {
    throw new Error(`${source}: approve must be a mapping`)
  }

  for (const field of approveFlags) {
    if (raw[field] !== undefined && typeof raw[field] !== 'boolean') {
      throw new Error(`${source}: approve.${field} must be a boolean`)
    }
  }

  return stripUndefined(Object.fromEntries(approveFlags.map(field => [field, raw[field] as boolean | undefined])) as ApproveConfig)
}

function normalizeLgtm(source: string, raw: unknown): LgtmConfig {
  if (!isMapping(raw)) {
    throw new Error(`${source}: lgtm must be a mapping`)
  }

  if (raw.bind_to_commit !== undefined && typeof raw.bind_to_commit !== 'boolean') {
    throw new Error(`${source}: lgtm.bind_to_commit must be a boolean`)
  }

  return stripUndefined({ bind_to_commit: raw.bind_to_commit as boolean | undefined })
}

function normalizeSweep(source: string, raw: unknown): SweepConfig {
  if (!isMapping(raw)) {
    throw new Error(`${source}: sweep must be a mapping`)
  }

  if (raw.lookback !== undefined) {
    if (typeof raw.lookback !== 'string') {
      throw new TypeError(`${source}: sweep.lookback must be a duration string such as 1h or 30m`)
    }
    let ms: number
    try {
      ms = parseDuration(raw.lookback, 'sweep.lookback')
    }
    catch (e) {
      throw new Error(`${source}: ${e instanceof Error ? e.message : e}`)
    }
    if (ms <= 0) {
      throw new Error(`${source}: sweep.lookback must be longer than 0`)
    }
  }

  return stripUndefined({ lookback: raw.lookback as string | undefined })
}

/**
 * resolveSweepLookback returns the sweep window in milliseconds: the
 * configured `sweep.lookback`, else 1h, never more than 24h.
 *
 * @param sweep - the merged sweep section
 */
export function resolveSweepLookback(sweep: SweepConfig): number {
  return Math.min(maxSweepLookbackMs, parseDuration(sweep.lookback ?? defaultSweepLookback, 'sweep.lookback'))
}

/**
 * mergeProwConfig layers `over` on top of `base`: label sections replace per
 * key, require_matching_label rules concatenate, tide, hold, blunderbuss,
 * approve, lgtm and sweep shallow-merge.
 *
 * @param base - the lower precedence tier
 * @param over - the higher precedence tier
 */
export function mergeProwConfig(base: Partial<ProwConfig>, over: Partial<ProwConfig>): Omit<ProwConfig, 'sources'> {
  return {
    labels: { ...base.labels, ...over.labels },
    require_matching_label: [...(base.require_matching_label ?? []), ...(over.require_matching_label ?? [])],
    tide: { ...base.tide, ...over.tide },
    hold: { ...base.hold, ...over.hold },
    blunderbuss: { ...base.blunderbuss, ...over.blunderbuss },
    approve: { ...base.approve, ...over.approve },
    lgtm: { ...base.lgtm, ...over.lgtm },
    sweep: { ...base.sweep, ...over.sweep },
  }
}

export interface ResolveTideOptions {
  /** the repository has OWNERS files, so the default gate also requires `approved` */
  hasOwners?: boolean
}

/**
 * resolveTide applies the defaults to a parsed tide section: `labels`
 * `['lgtm']`, or `['lgtm', 'approved']` when the repository has OWNERS files;
 * `missing_labels` the do-not-merge family, `needs-rebase` and `hold`. A
 * configured list replaces the default one, it does not extend it. The merge
 * method is `tide.merge_method`, else the `merge-method` action input, else
 * `merge`. `merge_on_events` defaults to true, `merge_queue` to `auto`.
 *
 * @param tide - the merged tide section
 * @param inputMergeMethod - the `merge-method` action input, if any
 * @param options - see ResolveTideOptions
 */
export function resolveTide(tide: TideConfig, inputMergeMethod = '', options: ResolveTideOptions = {}): ResolvedTide {
  return {
    labels: tide.labels ?? (options.hasOwners === true ? defaultOwnersTideLabels : defaultTideLabels),
    missing_labels: tide.missing_labels ?? defaultTideMissingLabels,
    merge_method: tide.merge_method ?? toMergeMethod(inputMergeMethod),
    merge_on_events: tide.merge_on_events ?? true,
    merge_queue: tide.merge_queue ?? 'auto',
  }
}

function toMergeMethod(input: string): MergeMethod {
  return (mergeMethods as readonly string[]).includes(input) ? input as MergeMethod : 'merge'
}

/**
 * resolveHoldLabel returns the label `/hold` applies: `hold.label`, else
 * Prow's `do-not-merge/hold`.
 *
 * @param hold - the merged hold section
 */
export function resolveHoldLabel(hold: HoldConfig): string {
  return hold.label ?? defaultHoldLabel
}

export function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
}

function isLabelList(value: unknown): value is string[] {
  return isStringList(value) && value.every(item => item !== '')
}

// keeps parsed objects comparable with `toEqual` and free of `key: undefined` noise
function stripUndefined<T extends object>(value: T): T {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T
}
