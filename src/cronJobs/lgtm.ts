import type { Octokit, RestEndpointMethodTypes } from '@octokit/rest'
import type { LgtmSettings } from '../plugins/lgtmBinding'
import type { ResolvedTide } from '../utils/config'
import type { Context } from '../utils/context'

import * as core from '@actions/core'
import * as github from '@actions/github'
import { lgtmSettings } from '../plugins/lgtmBinding'
import { evaluateMerge, loadTide, successfulResults } from '../plugins/tide'
import { loadProwConfig } from '../utils/config'
import { meetsMergeGate } from '../utils/mergeGate'
import { newOctokit } from '../utils/octokit'

type PullsListResponseDataType
  = RestEndpointMethodTypes['pulls']['list']['response']['data']

type PullsListResponseItem = PullsListResponseDataType extends (infer Item)[]
  ? Item
  : never

interface MergeFailure {
  number: number
  message: string
}

interface LgtmProgress {
  jobsDone: number
  failures: MergeFailure[]
}

interface MergePolicy {
  /** the tide configuration for a pull request's base branch; the gate default follows that branch's OWNERS files */
  tide: (base: string) => Promise<ResolvedTide>
  lgtm: LgtmSettings
}

/**
 * Inspired by https://github.com/actions/stale
 * this will recurse through the pages of PRs for a repo
 * and evaluate every one that passes the tide merge gate
 * (`tide.labels` present, no `tide.missing_labels`) on the listed labels
 * through the shared merge path: the lgtm binding, GitHub's mergeability,
 * then the merge. It is the backstop of the event-driven tide handlers.
 * Every PR is attempted; once all pages are processed the run fails
 * if any merge was refused, listing the affected PRs.
 *
 * @param currentPage - the page to return from the github api
 * @param context - The github actions event context
 * @param progress - merges done and failures collected on earlier pages
 */
export async function cronLgtm(
  currentPage: number,
  context: Context,
  progress: LgtmProgress = { jobsDone: 0, failures: [] },
): Promise<number> {
  core.info(`starting lgtm merger page: ${currentPage}`)

  const token = core.getInput('github-token', { required: true })
  const octokit = newOctokit(token)

  const policy: MergePolicy = {
    tide: base => loadTide(octokit, context, base),
    lgtm: lgtmSettings(await loadProwConfig(octokit, context)),
  }

  // Get next batch
  let prs: PullsListResponseDataType
  try {
    prs = await getOpenPrs(octokit, context, currentPage)
  }
  catch (e) {
    throw new Error(`could not get PRs: ${e}`)
  }

  if (prs.length <= 0) {
    // All done!
    if (progress.failures.length > 0) {
      const list = progress.failures.map(f => `#${f.number} (${f.message})`).join(', ')
      throw new Error(`${progress.failures.length} pull request(s) could not be merged: ${list}`)
    }
    return progress.jobsDone
  }

  const results = await Promise.all(
    prs.map(async (pr) => {
      core.info(`processing pr: ${pr.number}`)
      if (pr.state === 'closed') {
        return
      }

      if (pr.locked) {
        return
      }

      try {
        if (await tryMergePr(pr, octokit, context, policy, progress.failures)) {
          progress.jobsDone++
        }
      }
      catch (error) {
        return error
      }
    }),
  )

  for (const result of results) {
    if (result instanceof Error) {
      throw new TypeError(`error processing pr: ${result}`)
    }
  }

  // Recurse, continue to next page
  return await cronLgtm(currentPage + 1, context, progress)
}

/**
 * grabs pulls from github in baches of 100
 *
 * @param octokit - a hydrated github client
 * @param context - the github actions workflow context
 * @param page - the page number to get from the api
 */
async function getOpenPrs(
  octokit: Octokit,
  context: Context = github.context,
  page: number,
): Promise<PullsListResponseDataType> {
  core.debug(`getting prs page ${page}...`)

  const prResults = await octokit.pulls.list({
    ...context.repo,
    state: 'open',
    page,
  })

  core.debug(`got: ${prResults.data}`)

  return prResults.data
}

/**
 * Evaluates a PR that passes the tide merge gate on its listed labels
 * through the shared merge path; a PR that does not is skipped with the
 * reason logged and costs no further call. A refused merge is recorded in
 * failures instead of aborting the run. On a branch that requires a merge
 * queue the PR is enqueued instead; that counts as done.
 *
 * @param pr - the PR to try and merge
 * @param octokit - a hydrated github api client
 * @param context - the github actions event context
 * @param policy - the resolved tide and lgtm configuration
 * @param failures - collects PRs whose merge the api refused
 * @returns whether the PR was merged or enqueued
 */
async function tryMergePr(
  pr: PullsListResponseItem,
  octokit: Octokit,
  context: Context = github.context,
  policy: MergePolicy,
  failures: MergeFailure[],
): Promise<boolean> {
  const tide = await policy.tide(pr.base.ref)
  const gate = meetsMergeGate(pr.labels.map(e => e.name), tide)
  if (!gate.ok) {
    core.info(`skipping pr #${pr.number}: ${gate.reason}`)
    return false
  }

  const verdict = await evaluateMerge(octokit, context, pr.number, tide, policy.lgtm, { once: true })
  if (verdict.result === 'failed') {
    failures.push({ number: pr.number, message: verdict.message })
  }
  return successfulResults.has(verdict.result)
}
