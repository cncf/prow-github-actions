import type { Octokit, RestEndpointMethodTypes } from '@octokit/rest'
import type { ResolvedTide } from '../utils/config'
import type { Context } from '../utils/context'

import * as core from '@actions/core'
import * as github from '@actions/github'
import { loadTide, mergeOnce } from '../plugins/tide'
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

/**
 * Inspired by https://github.com/actions/stale
 * this will recurse through the pages of PRs for a repo
 * and attempt to merge every one that passes the tide merge gate
 * (`tide.labels` present, no `tide.missing_labels`). It is the backstop
 * of the event-driven tide handlers: it does not read each PR's
 * mergeable_state and lets GitHub refuse a merge instead.
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

  const tide = await loadTide(octokit, context)

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
        if (await tryMergePr(pr, octokit, context, tide, progress.failures)) {
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
 * Attempts to merge a PR that passes the tide merge gate; a PR that does
 * not is skipped with the reason logged. A refused merge is logged as an
 * error annotation and recorded in failures instead of aborting the run.
 *
 * @param pr - the PR to try and merge
 * @param octokit - a hydrated github api client
 * @param context - the github actions event context
 * @param tide - the resolved tide configuration
 * @param failures - collects PRs whose merge the api refused
 * @returns whether the PR was merged
 */
async function tryMergePr(
  pr: PullsListResponseItem,
  octokit: Octokit,
  context: Context = github.context,
  tide: ResolvedTide,
  failures: MergeFailure[],
): Promise<boolean> {
  const gate = meetsMergeGate(pr.labels.map(e => e.name), tide)
  if (!gate.ok) {
    core.info(`skipping pr #${pr.number}: ${gate.reason}`)
    return false
  }

  const outcome = await mergeOnce(octokit, context, pr.number, tide)
  if (outcome.result === 'merged') {
    return true
  }

  core.error(`could not merge pr #${pr.number}: ${outcome.message}`)
  failures.push({ number: pr.number, message: outcome.message })
  return false
}
