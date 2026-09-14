import type { Octokit } from '@octokit/rest'
import type { ResolvedTide } from '../utils/config'
import type { Context } from '../utils/context'

import * as core from '@actions/core'
import * as github from '@actions/github'

import { loadProwConfig, resolveTide } from '../utils/config'
import { meetsMergeGate } from '../utils/mergeGate'
import { newOctokit } from '../utils/octokit'
import { repoHasOwners } from '../utils/owners'
import { pullRequestsForSha } from '../utils/pulls'
import { sleep } from '../utils/sleep'

export interface Mergeability {
  /** GitHub's `mergeable_state`: clean, has_hooks, unstable, blocked, behind, dirty, draft or unknown */
  state: string
  mergeable: boolean | null
  labels: string[]
  draft: boolean
  locked: boolean
  merged: boolean
  state_open: boolean
  sha: string
}

export type MergeResult = 'merged' | 'skipped' | 'failed'

export type MergeOutcome = { result: 'merged' } | { result: 'failed', message: string }

export interface FetchMergeabilityOptions {
  /** called before each wait; returning false stops retrying an unknown state (default: always retry) */
  retryIf?: (pr: Mergeability) => boolean
}

// GitHub computes mergeability lazily: the first GET after a push starts the job and answers
// `unknown`, so poll with backoff (7 s in total) before giving up on this event
export const unknownRetryDelaysMs = [1000, 2000, 4000]

// `has_hooks` is `clean` with a pending non-required pre-receive hook
const mergeableStates = new Set(['clean', 'has_hooks'])

// `synchronize` is left out on purpose: a push removes lgtm (the lgtm PR job) and must not merge
const pullRequestActions = new Set(['labeled', 'unlabeled', 'reopened', 'ready_for_review', 'edited'])
const reviewActions = new Set(['submitted', 'dismissed'])
// a suite or status that ended this way cannot have made the pull request more mergeable
const hopelessConclusions = new Set(['failure', 'cancelled', 'timed_out', 'action_required', 'error', 'pending'])

/**
 * fetchMergeability reads the pull request and, while GitHub reports its
 * mergeability as `unknown`, re-reads it after growing waits. A state that
 * is still unknown after the last wait is returned as is.
 *
 * @param octokit - a hydrated github client
 * @param context - the github context of the current action event
 * @param number - the pull request number
 * @param options - see FetchMergeabilityOptions
 */
export async function fetchMergeability(
  octokit: Octokit,
  context: Context,
  number: number,
  options: FetchMergeabilityOptions = {},
): Promise<Mergeability> {
  const retryIf = options.retryIf ?? (() => true)

  let pr = await getPull(octokit, context, number)
  for (const delay of unknownRetryDelaysMs) {
    if (!isUnknown(pr) || !retryIf(pr)) {
      return pr
    }
    core.debug(`mergeability of pr #${number} is not computed yet, retrying in ${delay}ms`)
    await sleep(delay)
    pr = await getPull(octokit, context, number)
  }

  if (isUnknown(pr)) {
    core.info(`mergeability of pr #${number} is still unknown after ${unknownRetryDelaysMs.length} retries`)
  }
  return pr
}

/**
 * mergeOnce is the single `PUT /pulls/{n}/merge` call site shared by the
 * cron and the event handlers. A refused merge is returned, not thrown.
 *
 * @param octokit - a hydrated github client
 * @param context - the github context of the current action event
 * @param number - the pull request number
 * @param tide - the resolved tide configuration
 */
export async function mergeOnce(octokit: Octokit, context: Context, number: number, tide: ResolvedTide): Promise<MergeOutcome> {
  try {
    await octokit.pulls.merge({
      ...context.repo,
      pull_number: number,
      merge_method: tide.merge_method,
    })
    return { result: 'merged' }
  }
  catch (e) {
    return { result: 'failed', message: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * tryMergePullRequest evaluates one pull request against the tide gate and
 * GitHub's own mergeability and merges it when both pass. Unlike the cron,
 * it only merges a `clean` (or `has_hooks`) pull request; every other state
 * is skipped with the state as the reason. A refused merge is logged as an
 * error and reported as `failed`; the caller decides whether that fails the run.
 *
 * @param octokit - a hydrated github client
 * @param context - the github context of the current action event
 * @param number - the pull request number
 * @param tide - the resolved tide configuration
 */
export async function tryMergePullRequest(
  octokit: Octokit,
  context: Context,
  number: number,
  tide: ResolvedTide,
): Promise<MergeResult> {
  const pr = await fetchMergeability(octokit, context, number, {
    retryIf: candidate => blockedReason(candidate, tide) === undefined,
  })

  const reason = blockedReason(pr, tide) ?? (mergeableStates.has(pr.state) ? undefined : `not mergeable (${pr.state})`)
  if (reason !== undefined) {
    core.info(`skipping pr #${number}: ${reason}`)
    return 'skipped'
  }

  const outcome = await mergeOnce(octokit, context, number, tide)
  if (outcome.result === 'merged') {
    core.info(`merged pr #${number}`)
    return 'merged'
  }

  // two events for one pull request can race; the loser's merge is refused with 405 once the winner landed
  if (await isMerged(octokit, context, number)) {
    core.info(`pr #${number} was merged concurrently`)
    return 'skipped'
  }

  core.error(`could not merge pr #${number}: ${outcome.message}`)
  return 'failed'
}

function blockedReason(pr: Mergeability, tide: ResolvedTide): string | undefined {
  if (pr.merged) {
    return 'already merged'
  }
  if (!pr.state_open) {
    return 'closed'
  }
  if (pr.locked) {
    return 'locked'
  }
  if (pr.draft) {
    return 'not mergeable (draft)'
  }
  const gate = meetsMergeGate(pr.labels, tide)
  return gate.ok ? undefined : gate.reason
}

function isUnknown(pr: Mergeability): boolean {
  return pr.state === 'unknown' || pr.mergeable === null
}

async function getPull(octokit: Octokit, context: Context, number: number): Promise<Mergeability> {
  const { data } = await octokit.pulls.get({ ...context.repo, pull_number: number })
  return {
    state: data.mergeable_state,
    mergeable: data.mergeable ?? null,
    labels: data.labels.map(label => label.name),
    draft: data.draft ?? false,
    locked: data.locked,
    merged: data.merged,
    state_open: data.state === 'open',
    sha: data.head.sha,
  }
}

async function isMerged(octokit: Octokit, context: Context, number: number): Promise<boolean> {
  try {
    return (await getPull(octokit, context, number)).merged
  }
  catch {
    return false
  }
}

/**
 * tideOnPullRequest is the `pull_request` / `pull_request_target` handler:
 * on `labeled`, `unlabeled`, `reopened`, `ready_for_review` and `edited` it
 * evaluates the pull request. `opened` (nothing can be mergeable yet) and
 * `synchronize` (a push removes `lgtm`) are skipped.
 *
 * @param context - the github context of the current action event
 */
export async function tideOnPullRequest(context: Context = github.context): Promise<void> {
  const action: string | undefined = context.payload.action
  if (action === undefined || !pullRequestActions.has(action)) {
    core.debug(`tide: skipping ${action} action`)
    return
  }

  await evaluate(context, [pullNumber(context)])
}

/**
 * tideOnReview is the `pull_request_review` handler: a submitted or
 * dismissed review may satisfy or break branch protection and thereby flip
 * the pull request's mergeable_state. It does not turn reviews into `lgtm`.
 *
 * @param context - the github context of the current action event
 */
export async function tideOnReview(context: Context = github.context): Promise<void> {
  const action: string | undefined = context.payload.action
  if (action === undefined || !reviewActions.has(action)) {
    core.debug(`tide: skipping ${action} review action`)
    return
  }

  await evaluate(context, [pullNumber(context)])
}

/**
 * tideOnCheckSuite is the `check_suite` and `status` handler: when checks
 * finish it evaluates every open pull request whose head is the commit,
 * from the payload's `pull_requests` or, when that is empty, by listing.
 *
 * @param context - the github context of the current action event
 */
export async function tideOnCheckSuite(context: Context = github.context): Promise<void> {
  const suite = context.payload.check_suite
  const conclusion: string | undefined = suite?.conclusion ?? context.payload.state
  if (conclusion !== undefined && hopelessConclusions.has(conclusion)) {
    core.debug(`tide: a ${conclusion} ${context.eventName} cannot make a pull request mergeable`)
    return
  }

  const sha: unknown = suite?.head_sha ?? context.payload.sha
  if (typeof sha !== 'string') {
    throw new TypeError(`github context payload missing head sha: ${JSON.stringify(context.payload)}`)
  }

  const listed: number[] = (suite?.pull_requests ?? []).map((pr: { number: number }) => pr.number)
  await evaluate(context, listed, async octokit => pullRequestsForSha(octokit, context, sha))
}

/**
 * loadTide reads the configuration and resolves the tide section. The
 * `labels` default depends on whether the repository has OWNERS files
 * (`[lgtm, approved]`) or not (`[lgtm]`); that lookup is skipped when
 * `tide.labels` is configured, and memoized otherwise.
 *
 * @param octokit - a hydrated github client
 * @param context - the github context of the current action event
 */
export async function loadTide(octokit: Octokit, context: Context): Promise<ResolvedTide> {
  const config = await loadProwConfig(octokit, context)
  const hasOwners = config.tide.labels === undefined ? await repoHasOwners(octokit, context) : false
  return resolveTide(config.tide, core.getInput('merge-method', { required: false }), { hasOwners })
}

async function evaluate(
  context: Context,
  numbers: number[],
  lookup?: (octokit: Octokit) => Promise<number[]>,
): Promise<void> {
  const octokit = newOctokit(core.getInput('github-token', { required: true }))
  const config = await loadProwConfig(octokit, context)
  if (config.tide.merge_on_events === false) {
    core.debug('tide: merge_on_events is false, leaving the merge to the lgtm cron')
    return
  }
  const tide = await loadTide(octokit, context)

  const candidates = numbers.length === 0 && lookup !== undefined ? await lookup(octokit) : numbers
  if (candidates.length === 0) {
    core.debug('tide: no open pull request to evaluate')
    return
  }

  const results = await Promise.all(candidates.map(number => tryMergePullRequest(octokit, context, number, tide)))
  const failed = candidates.filter((_, i) => results[i] === 'failed')
  if (failed.length > 0) {
    throw new Error(`could not merge pull request(s) ${failed.map(number => `#${number}`).join(', ')}`)
  }
}

function pullNumber(context: Context): number {
  const number: number | undefined = context.payload.pull_request?.number
  if (number === undefined) {
    throw new Error(`github context payload missing pull request: ${JSON.stringify(context.payload)}`)
  }
  return number
}
