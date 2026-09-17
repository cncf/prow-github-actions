import type { Octokit, RestEndpointMethodTypes } from '@octokit/rest'
import type { ProwConfig } from '../utils/config'
import type { Context } from '../utils/context'

import * as core from '@actions/core'
import * as github from '@actions/github'

import { approvePendingRuns, okToTestLabel } from '../issueComment/trigger'
import { evaluateApproval } from '../plugins/approve'
import { blunderbussSettings, requestOwnersReviewers } from '../plugins/blunderbuss'
import { lgtmSettings } from '../plugins/lgtmBinding'
import { applyOwnersLabels } from '../plugins/ownersLabel'
import { enforceRequiredLabels } from '../plugins/requireMatchingLabel'
import { evaluateMerge, loadTide } from '../plugins/tide'
import { loadProwConfig, resolveSweepLookback } from '../utils/config'
import { newOctokit } from '../utils/octokit'
import { repoHasOwners } from '../utils/owners'

type PullsListItem = RestEndpointMethodTypes['pulls']['list']['response']['data'][number]

export interface SweepFailure {
  number: number
  message: string
}

export interface SweepResult {
  candidates: number[]
  merged: number[]
  failures: SweepFailure[]
}

/** pull requests evaluated at once; keeps a busy repository within the api's secondary rate limits */
export const sweepConcurrency = 3

const pageSize = 100

/**
 * sweep is the scheduled job of the `pull_request` install mode: for every
 * open pull request updated within `sweep.lookback` it does what the
 * `pull_request` and `pull_request_review` handlers would have done with a
 * write token, in their order: the `require_matching_label` rules, the OWNERS
 * labels, blunderbuss on a fresh pull request nobody reviews yet, the
 * approval, the pending runs of a pull request labeled `ok-to-test`, then the merge path (lgtm binding, mergeability, merge). Each
 * pull request is evaluated sequentially, a few pull requests at a time; a
 * failure on one is collected and the rest still run. The run fails at the
 * end listing the failures.
 *
 * @param context - the github actions event context
 * @param now - the current time, injectable for tests
 */
export async function sweep(context: Context = github.context, now: Date = new Date()): Promise<SweepResult> {
  const octokit = newOctokit(core.getInput('github-token', { required: true }))
  const config = await loadProwConfig(octokit, context)
  const lookbackMs = resolveSweepLookback(config.sweep)
  const since = new Date(now.getTime() - lookbackMs)

  const candidates = await recentlyUpdatedPulls(octokit, context, since)
  core.info(`sweep: ${candidates.length} candidate${candidates.length === 1 ? '' : 's'} updated since ${since.toISOString()}`)

  const result: SweepResult = { candidates: candidates.map(pr => pr.number), merged: [], failures: [] }
  if (candidates.length === 0) {
    return result
  }

  const plugins = {
    hasOwners: await repoHasOwners(octokit, context),
    tide: await loadTide(octokit, context),
    lgtm: lgtmSettings(config),
    config,
    since,
  }

  await forEachLimited(candidates, sweepConcurrency, async (pr) => {
    const outcome = await sweepPullRequest(octokit, context, pr, plugins)
    if (outcome.merged) {
      result.merged.push(pr.number)
    }
    if (outcome.errors.length > 0) {
      result.failures.push({ number: pr.number, message: outcome.errors.join('; ') })
    }
  })

  if (result.failures.length > 0) {
    const list = result.failures.map(f => `#${f.number} (${f.message})`).join(', ')
    throw new Error(`sweep: ${result.failures.length} pull request(s) failed: ${list}`)
  }
  return result
}

interface SweepPlugins {
  hasOwners: boolean
  tide: Awaited<ReturnType<typeof loadTide>>
  lgtm: ReturnType<typeof lgtmSettings>
  config: ProwConfig
  since: Date
}

interface PullOutcome {
  merged: boolean
  errors: string[]
}

type Step = [name: string, run: () => Promise<void>]

async function sweepPullRequest(octokit: Octokit, context: Context, pr: PullsListItem, plugins: SweepPlugins): Promise<PullOutcome> {
  const outcome: PullOutcome = { merged: false, errors: [] }
  const ownersSteps: Step[] = [
    ['owners-label', () => applyOwnersLabels(octokit, context, pr.number)],
    ['blunderbuss', () => requestReviewersIfFresh(octokit, context, pr, plugins)],
    ['approve', () => evaluateApproval(octokit, context, pr.number)],
  ]
  const steps: Step[] = [
    ['require-matching-label', () => enforceRequiredLabels(octokit, context, { issueNumber: pr.number, isPullRequest: true })],
    ...(plugins.hasOwners ? ownersSteps : []),
    ['ok-to-test', () => approveIfTrusted(octokit, context, pr)],
    ['tide', async () => {
      const verdict = await evaluateMerge(octokit, context, pr.number, plugins.tide, plugins.lgtm)
      if (verdict.result === 'merged') {
        outcome.merged = true
      }
      else if (verdict.result === 'failed') {
        throw new Error(verdict.message)
      }
    }],
  ]

  for (const [name, step] of steps) {
    try {
      await step()
    }
    catch (e) {
      outcome.errors.push(`${name}: ${e instanceof Error ? e.message : String(e)}`)
    }
  }

  core.info(`sweep: #${pr.number} ${outcome.merged ? 'merged' : 'evaluated'}${outcome.errors.length === 0 ? '' : ` with ${outcome.errors.length} error(s)`}`)
  return outcome
}

async function approveIfTrusted(octokit: Octokit, context: Context, pr: PullsListItem): Promise<void> {
  if (!(pr.labels ?? []).some(label => label.name.toLowerCase() === okToTestLabel)) {
    core.debug(`sweep: #${pr.number} does not carry ${okToTestLabel}`)
    return
  }
  await approvePendingRuns(octokit, context, pr.number, pr.head.sha)
}

async function requestReviewersIfFresh(octokit: Octokit, context: Context, pr: PullsListItem, plugins: SweepPlugins): Promise<void> {
  if (new Date(pr.created_at) < plugins.since) {
    core.debug(`sweep: #${pr.number} was opened before the window; no reviewers requested`)
    return
  }
  if (pr.draft === true || (pr.requested_reviewers ?? []).length > 0) {
    core.debug(`sweep: #${pr.number} is a draft or already has requested reviewers`)
    return
  }
  const { data: reviews } = await octokit.pulls.listReviews({ ...context.repo, pull_number: pr.number, per_page: 1 })
  if (reviews.length > 0) {
    core.debug(`sweep: #${pr.number} already has reviews`)
    return
  }

  await requestOwnersReviewers(octokit, context, pr.number, blunderbussSettings(plugins.config), { explicit: false, rng: Math.random })
}

async function recentlyUpdatedPulls(octokit: Octokit, context: Context, since: Date): Promise<PullsListItem[]> {
  const candidates: PullsListItem[] = []

  for (let page = 1; ; page++) {
    let items: PullsListItem[]
    try {
      items = (await octokit.pulls.list({ ...context.repo, state: 'open', sort: 'updated', direction: 'desc', per_page: pageSize, page })).data
    }
    catch (e) {
      throw new Error(`sweep: could not list the open pull requests: ${e}`)
    }

    candidates.push(...items.filter(pr => new Date(pr.updated_at) >= since))
    const exhausted = items.length < pageSize || new Date(items[items.length - 1].updated_at) < since
    if (exhausted) {
      return candidates
    }
  }
}

async function forEachLimited<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      await fn(items[next++])
    }
  })
  await Promise.all(workers)
}
