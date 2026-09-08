import type { Context } from '@actions/github/lib/context'
import type { Octokit } from '@octokit/rest'

import { Buffer } from 'node:buffer'

import * as core from '@actions/core'

import * as yaml from 'js-yaml'

/**
 * getArgumentLabels will get the .prowlabels.yaml or .prowlabels.yml file.
 * it will then return the section specified by arg.
 *
 * This method has some eslint ignores related to
 * no explicit typing in octokit for content response - https://github.com/octokit/rest.js/issues/1516
 *
 * @param octokit - a hydrated github client
 * @param context - the github actions event context
 * @param arg - the label section to return. For example, may be 'area', etc
 */
export async function getArgumentLabels(
  octokit: Octokit,
  context: Context,
  arg: string,
): Promise<string[]> {
  let response: any
  try {
    response = await octokit.repos.getContent({
      ...context.repo,
      path: '.prowlabels.yaml',
    })
  }
  catch (e) {
    try {
      response = await octokit.repos.getContent({
        ...context.repo,
        path: '.prowlabels.yml',
      })
    }
    catch (e2) {
      throw new Error(
        `could not get .prowlabels.yaml or .prowlabels.yml: ${e} ${e2}`,
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

  const content: any = yaml.load(decoded)

  if (!content[arg] && !Array.isArray(content[arg])) {
    throw new Error(`${arg}: yaml malformed, expected '${arg}' top level key`)
  }

  return content[arg]
}

/**
 * labelIssue will label the issue with the labels provided
 *
 * @param octokit - a hydrated github client
 * @param context - the github actions event context
 * @param issueNum - the issue associated with this runtime
 * @param labels - the labels to add to the issue
 */
export async function labelIssue(
  octokit: Octokit,
  context: Context,
  issueNum: number,
  labels: string[],
): Promise<void> {
  try {
    await octokit.issues.addLabels({
      ...context.repo,
      issue_number: issueNum,
      labels,
    })
  }
  catch (e) {
    throw new Error(`could not add labels: ${e}`)
  }
}

/**
 * getCurrentLabels will return the labels for the associated issue
 *
 * @param octokit - a hydrated github client
 * @param context - the github actions event context
 * @param issueNum - the issue associated with this runtime
 */
export async function getCurrentLabels(
  octokit: Octokit,
  context: Context,
  issueNum: number,
): Promise<string[]> {
  try {
    const issue = await octokit.issues.get({
      ...context.repo,
      issue_number: issueNum,
    })

    return issue.data.labels.map((e): string => {
      if (typeof e == 'object') {
        return e.name || ''
      }
      return e
    })
  }
  catch (e) {
    throw new Error(`could not get issue: ${e}`)
  }
}

/**
 * removeLabels will remove labels for the issue with the labels provided
 *
 * @param octokit - a hydrated github client
 * @param context - the github actions event context
 * @param issueNum - the issue associated with this runtime
 * @param labels - the labels to remove from the issue
 */
export async function removeLabels(
  octokit: Octokit,
  context: Context,
  issueNum: number,
  labels: string[],
): Promise<void> {
  for (const label of labels) {
    try {
      await octokit.issues.removeLabel({
        ...context.repo,
        issue_number: issueNum,
        name: label,
      })
    }
    catch (e) {
      // a gone label is a benign race; anything else is a real failure
      if (isNotFound(e))
        core.debug(`label ${label} was already absent: ${e}`)
      else
        throw new Error(`could not remove label ${label}: ${e}`)
    }
  }
}

/**
 * addPrefix will add the associated prefix to the arguments array
 *
 * @param prefix - the prefix to add to the args
 * @param args - the strings to add the prefix to
 */
export function addPrefix(prefix: string, args: string[]): string[] {
  const toReturn: string[] = []

  for (const arg of args) {
    toReturn.push(`${prefix}/${arg}`)
  }

  return toReturn
}

/**
 * cancelLabel will remove an associated label
 *
 * @param octokit - a hydrated github client
 * @param context - the github actions event context
 * @param issueNum - the issue associated with this runtime
 * @param labels - the label to remove from the issue
 */
export async function cancelLabel(
  octokit: Octokit,
  context: Context,
  issueNum: number,
  label: string,
): Promise<void> {
  let currentLabels: string[] = []
  try {
    currentLabels = await getCurrentLabels(octokit, context, issueNum)
    core.debug(`remove: found labels for issue ${currentLabels}`)
  }
  catch (e) {
    throw new Error(`could not get labels from issue: ${e}`)
  }

  if (currentLabels.includes(label)) {
    try {
      await removeLabels(octokit, context, issueNum, [label])
    }
    catch (e) {
      throw new Error(`could not remove ${label} label: ${e}`)
    }
  }
  else {
    core.debug(`could not find ${label} to remove`)
  }
}

// isNotFound reports whether an octokit error is a 404
function isNotFound(error: unknown): boolean {
  return (
    typeof error === 'object'
    && error !== null
    && 'status' in error
    && error.status === 404
  )
}
