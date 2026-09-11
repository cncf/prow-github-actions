import type { Octokit } from '@octokit/rest'
import type { Context } from './context'

import { Buffer } from 'node:buffer'

import * as core from '@actions/core'

import * as yaml from 'js-yaml'

/** one top level key of .prowlabels.yaml */
export interface LabelSection {
  /** the allowed values, ex: ['bug', 'cleanup'] */
  values: string[]
  /** replace any existing '<prefix>/*' labels instead of stacking them */
  exclusive?: boolean
}

export type LabelConfig = Record<string, LabelSection>

/**
 * getLabelConfig fetches .prowlabels.yaml (or .prowlabels.yml) and returns
 * every top level key as a LabelSection. A key may be written as a plain
 * list of values or as a mapping `{ values: [...], exclusive: bool }`.
 *
 * This method has some eslint ignores related to
 * no explicit typing in octokit for content response - https://github.com/octokit/rest.js/issues/1516
 *
 * @param octokit - a hydrated github client
 * @param context - the github actions event context
 */
export async function getLabelConfig(
  octokit: Octokit,
  context: Context,
): Promise<LabelConfig> {
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

  const content: unknown = yaml.load(decoded)
  const sections: Record<string, unknown> = isMapping(content) ? content : {}

  return Object.fromEntries(
    Object.entries(sections).map(([key, section]) => [key, normalizeSection(key, section)]),
  )
}

/**
 * getArgumentLabels returns the allowed values of one .prowlabels.yaml section
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

function normalizeSection(key: string, section: unknown): LabelSection {
  if (isStringList(section)) {
    return { values: section }
  }

  if (
    isMapping(section)
    && isStringList(section.values)
    && (section.exclusive === undefined || typeof section.exclusive === 'boolean')
  ) {
    return { values: section.values, exclusive: section.exclusive }
  }

  throw new Error(
    `${key}: yaml malformed, expected a list of values or { values: [...], exclusive: bool }`,
  )
}

function isMapping(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isStringList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string')
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
