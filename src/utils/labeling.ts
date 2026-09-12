import type { Octokit } from '@octokit/rest'
import type { LabelSection } from './config'
import type { Context } from './context'

import * as core from '@actions/core'

import { loadProwConfig, orgConfigPath, orgConfigRepos, repoConfigPaths } from './config'

export type { LabelSection } from './config'

export type LabelConfig = Record<string, LabelSection>

/**
 * getLabelConfig returns the label sections of the merged prow configuration
 * (organization or explicit source, then the repository). Label commands need
 * a configuration file to exist somewhere, so an entirely absent configuration
 * is an error that names every location that was probed.
 *
 * @param octokit - a hydrated github client
 * @param context - the github actions event context
 */
export async function getLabelConfig(
  octokit: Octokit,
  context: Context,
): Promise<LabelConfig> {
  const config = await loadProwConfig(octokit, context)

  if (config.sources.length === 0) {
    const { owner, repo } = context.repo
    const orgRepos = orgConfigRepos.map(name => `${owner}/${name}`).join(' and ')
    const repoFiles = repoConfigPaths.filter(path => path.endsWith('.yaml')).join(', ')
    throw new Error(
      `no prow configuration found: looked for ${orgConfigPath} in ${orgRepos}, and ${repoFiles} (.yaml/.yml) in ${owner}/${repo}`,
    )
  }

  return config.labels
}

/**
 * getArgumentLabels returns the allowed values of one label section
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
  const config = await getLabelConfig(octokit, context)
  const section = config[arg]

  if (!section) {
    throw new Error(`${arg}: yaml malformed, expected '${arg}' top level key`)
  }

  return section.values
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
 * addPrefix will add the associated prefix to the arguments array.
 * An empty prefix returns the args unchanged rather than '/arg'
 *
 * @param prefix - the prefix to add to the args
 * @param args - the strings to add the prefix to
 */
export function addPrefix(prefix: string, args: string[]): string[] {
  if (prefix === '') {
    return [...args]
  }

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
