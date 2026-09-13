import type { Octokit } from '@octokit/rest'
import type { ResolvedTide } from '../utils/config'
import type { Context } from '../utils/context'

import * as core from '@actions/core'

import { meetsMergeGate } from '../utils/mergeGate'
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
