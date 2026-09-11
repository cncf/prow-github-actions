import type { Octokit, RestEndpointMethodTypes } from '@octokit/rest'
import type { Context } from '../utils/context'

import * as core from '@actions/core'
import * as github from '@actions/github'
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
 * and attempt to merge them if they have the "lgtm" label.
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
        if (await tryMergePr(pr, octokit, context, progress.failures)) {
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
 * Attempts to merge a PR if it has the lgtm label and not the hold label.
 * A refused merge is logged as an error annotation and recorded in
 * failures instead of aborting the run.
 *
 * @param pr - the PR to try and merge
 * @param octokit - a hydrated github api client
 * @param context - the github actions event context
 * @param failures - collects PRs whose merge the api refused
 * @returns whether the PR was merged
 */
async function tryMergePr(
  pr: PullsListResponseItem,
  octokit: Octokit,
  context: Context = github.context,
  failures: MergeFailure[],
): Promise<boolean> {
  const method = core.getInput('merge-method', { required: false })

  const names = pr.labels.map(e => e.name)
  if (!names.includes('lgtm') || names.includes('hold')) {
    return false
  }

  try {
    await octokit.pulls.merge({
      ...context.repo,
      pull_number: pr.number,
      merge_method: mergeMethod(method),
    })
    return true
  }
  catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    core.error(`could not merge pr #${pr.number}: ${message}`)
    failures.push({ number: pr.number, message })
    return false
  }
}

// an unknown merge-method input falls back to 'merge'
function mergeMethod(input: string): 'merge' | 'squash' | 'rebase' {
  switch (input) {
    case 'squash':
    case 'rebase':
      return input
    default:
      return 'merge'
  }
}
