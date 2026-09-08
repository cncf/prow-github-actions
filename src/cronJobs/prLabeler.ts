/**
 * @deprecated - it's no longer recommended to use the cron labeler for PRs.
 * As of ~2020, GitHub actions support `pull_request_target` which can be used with
 * the "actions/labeler" workflow. This supports labeling PRs when they are opened,
 * even from forks (which this feature attempted to subvert via a cron).
 */

import type { Context } from '@actions/github/lib/context'
import type { Endpoints } from '@octokit/types'

import { Buffer } from 'node:buffer'
import * as core from '@actions/core'
import * as github from '@actions/github'

import { Octokit } from '@octokit/rest'
import * as yaml from 'js-yaml'

import * as minimatch from 'minimatch'

// This variable is used to track number of jobs processed
// while recursing through pages of the github api
let jobsDone = 0

type PullsListResponseDataType
  = Endpoints['GET /repos/{owner}/{repo}/pulls']['response']['data']

/**
 * Inspired by https://github.com/actions/stale
 * this will recurse through the pages of PRs for a repo returned
 * by the github API.
 *
 * @param currentPage - the page to return from the github api
 * @param context - The github actions event context
 */
export async function cronLabelPr(
  currentPage: number,
  context: Context,
): Promise<number> {
  core.info(`starting PR labeler page ${currentPage}`)

  const token = core.getInput('github-token', { required: true })
  const octokit = new Octokit({
    auth: token,
  })

  // Get next batch
  let prs: PullsListResponseDataType
  try {
    prs = await getPrs(octokit, context, currentPage)
  }
  catch (e) {
    throw new Error(`could not get PRs: ${e}`)
  }

  if (prs.length <= 0) {
    // All done!
    return jobsDone
  }

  await Promise.all(
    prs.map(async (pr) => {
      core.info(`processing pr: ${pr.number}`)
      if (pr.state === 'closed') {
        return
      }

      if (pr.locked) {
        return
      }

      await labelPr(pr.number, context, octokit)
      jobsDone++
    }),
  )

  // Recurse, continue to next page
  return cronLabelPr(currentPage + 1, context)
}

/**
 * grabs pulls from github in baches of 100
 *
 * @param octokit - a hydrated github client
 * @param context - the github actions workflow context
 * @param page - the page number to get from the api
 */
async function getPrs(
  octokit: Octokit,
  context: Context = github.context,
  page: number,
): Promise<PullsListResponseDataType> {
  core.debug(`getting prs page ${page}...`)
  const prResults = await octokit.pulls.list({
    ...context.repo,
    page,
  })

  core.debug(`got: ${prResults.data}`)

  return prResults.data
}

/**
 * Inspired by https://github.com/actions/labeler
 *    - Uses js-yaml to load labeler.yaml
 *    - Uses Minimatch to match globs to changed files
 * @param context - the Github context for pull req event
 * @param prNum - the PR to label
 * @param octokit - a hydrated github client
 */
async function labelPr(
  prNum: number,
  context: Context = github.context,
  octokit: Octokit,
): Promise<void> {
  const changedFiles = await getChangedFiles(octokit, context, prNum)
  const labels = await getLabelsFromFileGlobs(octokit, context, changedFiles)

  if (labels.length === 0) {
    core.debug('pr-labeler: no labels matched file globs')
    return
  }

  await sendLabels(octokit, context, prNum, labels)
}

/**
 * returns the changed files for the PR
 *
 * @param octokit - a hydrated github api client
 * @param context - the github workflows event context
 * @param prNum - the PR to check
 */
async function getChangedFiles(
  octokit: Octokit,
  context: Context,
  prNum: number,
): Promise<string[]> {
  core.debug(`getting changed files for pr ${prNum}`)
  const listFilesResponse = await octokit.pulls.listFiles({
    ...context.repo,
    pull_number: prNum,
  })

  const changedFiles = listFilesResponse.data.map(f => f.filename)
  core.debug(`files changed: ${changedFiles}`)

  return changedFiles
}

/**
 * Will match the globs found in /.github/workflows.yaml
 * with the files that have changed in the PR
 *
 * @param octokit - a hydrated github api client
 * @param context - the github workflows event context
 * @param files - the list of files that have changed in the PR
 */
async function getLabelsFromFileGlobs(
  octokit: Octokit,
  context: Context,
  files: string[],
): Promise<string[]> {
  const toReturn: string[] = []

  core.debug(`getting labels.yaml file and matching file globs`)
  let response: any
  try {
    response = await octokit.rest.repos.getContent({
      ...context.repo,
      path: '.github/labels.yaml',
    })
  }
  catch (e) {
    try {
      response = await octokit.rest.repos.getContent({
        ...context.repo,
        path: '.github/labels.yml',
      })
    }
    catch (e2) {
      throw new Error(
        `could not get .github/labels.yaml or .github/labels.yml: ${e} ${e2}`,
      )
    }
  }

  if (!response.data.content || !response.data.encoding) {
    throw new Error(
      `area: error parsing data from content response: ${response.data}`,
    )
  }

  const decoded = Buffer.from(
    response.data.content,
    response.data.encoding,
  ).toString()

  core.debug(`label file contents: ${decoded}`)
  const content: any = yaml.load(decoded)

  const labelMap: Map<string, string[]> = new Map()

  for (const label in content) {
    if (typeof content[label] === 'string') {
      labelMap.set(label, [content[label]])
    }
    else if (Array.isArray(content[label])) {
      labelMap.set(label, content[label])
    }
    else {
      throw new TypeError(
        `pr-labeler: found unexpected type for label ${label} (should be string or array of globs)`,
      )
    }
  }

  for (const [label, globs] of labelMap.entries()) {
    if (checkGlobs(files, globs)) {
      toReturn.push(label)
    }
  }

  return toReturn
}

/**
 * Returns true if a match between the globs and corresponding file changes
 * in the PR
 *
 * @param files - list of files that have changed
 * @param globs - list of globs to match against files
 */
function checkGlobs(files: string[], globs: string[]): boolean {
  for (const glob of globs) {
    const matcher = new minimatch.Minimatch(glob)
    for (const file of files) {
      core.debug(`comparing file: ${file} to glob: ${glob}`)
      if (matcher.match(file)) {
        core.debug(`success! Glob and file match`)
        return true
      }
    }
  }
  return false
}

/**
 * Labels a given PR with given labels
 *
 * @param octokit - a hydrated github api client
 * @param context - the github workflow event context
 * @param prNum - the PR to label
 * @param labels - the labels for the PR
 */
export async function sendLabels(
  octokit: Octokit,
  context: Context,
  prNum: number,
  labels: string[],
): Promise<void> {
  try {
    core.debug(`sending labels ${labels} for PR ${prNum}`)
    await octokit.issues.addLabels({
      ...context.repo,
      issue_number: prNum,
      labels,
    })
  }
  catch (e) {
    throw new Error(`sending labels: ${e}`)
  }
}
