import type { Octokit } from '@octokit/rest'
import type { ProwConfig } from '../utils/config'
import type { Context } from '../utils/context'

import * as core from '@actions/core'
import * as github from '@actions/github'

import { loadProwConfig } from '../utils/config'
import { newOctokit } from '../utils/octokit'
import { loadPullRequestOwners } from '../utils/pullRequestOwners'

export interface BlunderbussSettings {
  request_count: number
  max_request_count: number | undefined
  exclude_approvers: boolean
  ignore_drafts: boolean
  ignore_authors: string[]
}

export type Rng = () => number

/**
 * blunderbussSettings resolves the `blunderbuss` configuration with Prow's
 * defaults: two reviewers, approvers count, drafts wait for ready_for_review.
 *
 * @param config - the merged prow configuration
 */
export function blunderbussSettings(config: ProwConfig): BlunderbussSettings {
  const raw = config.blunderbuss
  return {
    request_count: raw.request_count ?? 2,
    max_request_count: raw.max_request_count,
    exclude_approvers: raw.exclude_approvers ?? false,
    ignore_drafts: raw.ignore_drafts ?? true,
    ignore_authors: (raw.ignore_authors ?? []).map(login => login.toLowerCase()),
  }
}

/**
 * pickReviewers chooses `count` logins. Like Prow, a reviewer is weighted by
 * the number of changed files they cover: candidates are tiered by that count
 * and the request is filled from the highest tier down, drawing at random
 * within the tier that would overflow it.
 *
 * @param coverage - login to the number of changed files the login covers
 * @param count - how many reviewers to pick
 * @param rng - a source of numbers in [0, 1), injectable for tests
 */
export function pickReviewers(coverage: Map<string, number>, count: number, rng: Rng = Math.random): string[] {
  const tiers = new Map<number, string[]>()
  for (const [login, files] of coverage) {
    tiers.set(files, [...(tiers.get(files) ?? []), login])
  }

  const picked: string[] = []
  for (const files of [...tiers.keys()].sort((a, b) => b - a)) {
    const remaining = count - picked.length
    if (remaining <= 0) {
      break
    }
    const tier = [...tiers.get(files)!].sort()
    picked.push(...(tier.length <= remaining ? tier : sample(tier, remaining, rng)))
  }
  return picked
}

function sample(items: string[], count: number, rng: Rng): string[] {
  const pool = [...items]
  const drawn: string[] = []
  while (drawn.length < count && pool.length > 0) {
    const [item] = pool.splice(Math.floor(rng() * pool.length), 1)
    drawn.push(item)
  }
  return drawn
}

/**
 * blunderbuss is the `pull_request` handler modelled on Prow's blunderbuss
 * plugin: on `opened` (and `ready_for_review` when drafts are ignored) it
 * requests reviews from the OWNERS reviewers covering the changed files.
 *
 * @param context - the github context of the current action event
 * @param rng - a source of numbers in [0, 1), injectable for tests
 */
export async function blunderbuss(context: Context = github.context, rng: Rng = Math.random): Promise<void> {
  const action: string | undefined = context.payload.action
  if (action !== 'opened' && action !== 'ready_for_review') {
    core.debug(`blunderbuss: skipping ${action} action`)
    return
  }

  const pullNumber: number | undefined = context.payload.pull_request?.number
  if (pullNumber === undefined) {
    throw new Error(`github context payload missing pull request: ${JSON.stringify(context.payload)}`)
  }

  const octokit = newOctokit(core.getInput('github-token', { required: true }))
  const settings = blunderbussSettings(await loadProwConfig(octokit, context))

  if (action === 'ready_for_review' && !settings.ignore_drafts) {
    core.debug(`blunderbuss: skipping ${action} action`)
    return
  }

  await requestOwnersReviewers(octokit, context, pullNumber, settings, { explicit: false, rng })
}

/**
 * autoCc is the `/auto-cc` comment command: it runs the blunderbuss selection
 * on the pull request regardless of its draft state or author.
 *
 * @param context - the github context of the current action event
 * @param rng - a source of numbers in [0, 1), injectable for tests
 */
export async function autoCc(context: Context = github.context, rng: Rng = Math.random): Promise<void> {
  const issue = context.payload.issue
  if (issue?.pull_request === undefined) {
    core.debug('blunderbuss: /auto-cc only applies to pull requests')
    return
  }

  const octokit = newOctokit(core.getInput('github-token', { required: true }))
  const settings = blunderbussSettings(await loadProwConfig(octokit, context))

  await requestOwnersReviewers(octokit, context, issue.number, settings, { explicit: true, rng })
}

export interface RequestReviewersOptions {
  /** `/auto-cc`: ignore the draft state and `ignore_authors` */
  explicit: boolean
  rng: Rng
}

/**
 * requestOwnersReviewers runs the blunderbuss selection on one pull request
 * and requests the picked reviewers; a no-op when nobody is left to pick.
 *
 * @param octokit - a hydrated github client
 * @param context - the github context of the current action event
 * @param pullNumber - the pull request
 * @param settings - the resolved blunderbuss configuration
 * @param options - see RequestReviewersOptions
 */
export async function requestOwnersReviewers(
  octokit: Octokit,
  context: Context,
  pullNumber: number,
  settings: BlunderbussSettings,
  options: RequestReviewersOptions,
): Promise<void> {
  const { explicit, rng } = options
  const pull = await loadPullRequestOwners(octokit, context, pullNumber)

  if (!explicit) {
    if (settings.ignore_drafts && pull.draft) {
      core.debug(`blunderbuss: #${pullNumber} is a draft, waiting for ready_for_review`)
      return
    }
    if (settings.ignore_authors.includes(pull.author)) {
      core.debug(`blunderbuss: ignoring pull request by ${pull.author}`)
      return
    }
  }

  const excluded = new Set([pull.author, ...pull.requestedReviewers, ...pull.assignees])
  const coverage = new Map<string, number>()
  for (const owners of pull.perFile.values()) {
    if (owners === undefined) {
      continue
    }
    const logins = new Set([...owners.reviewers, ...(settings.exclude_approvers ? [] : owners.approvers)])
    for (const login of logins) {
      if (!excluded.has(login)) {
        coverage.set(login, (coverage.get(login) ?? 0) + 1)
      }
    }
  }

  if (coverage.size === 0) {
    core.debug(`blunderbuss: no reviewer candidates for #${pullNumber}`)
    return
  }

  let count = settings.request_count
  if (settings.max_request_count !== undefined) {
    count = Math.min(count, settings.max_request_count - pull.requestedReviewers.length)
    if (count <= 0) {
      core.debug(`blunderbuss: #${pullNumber} already has ${pull.requestedReviewers.length} requested reviewers, max_request_count is ${settings.max_request_count}`)
      return
    }
  }

  const reviewers = pickReviewers(coverage, count, rng)
  try {
    await octokit.pulls.requestReviewers({ ...context.repo, pull_number: pullNumber, reviewers })
  }
  catch (e) {
    throw new Error(`could not request reviewers: ${e}`)
  }
  core.info(`blunderbuss: requested review from ${reviewers.join(', ')} on #${pullNumber}`)
}
