import type { Context } from '../utils/context'
import * as core from '@actions/core'

import { getCurrentLabels, labelIssue, removeLabels } from '../utils/labeling'
import { newOctokit } from '../utils/octokit'
import { sameLabel } from './prefixed'

export interface FixedLabelCommand {
  /** the slash command, ex: '/help' */
  command: string
  /** labels applied by the command */
  add: string[]
  /** labels removed by the /remove- form, when present on the issue */
  remove: string[]
}

// Prow's help plugin: label names contain spaces so they bypass the label configuration
export const fixedLabelCommands: FixedLabelCommand[] = [
  { command: '/help', add: ['help wanted'], remove: ['help wanted', 'good first issue'] },
  { command: '/good-first-issue', add: ['good first issue', 'help wanted'], remove: ['good first issue'] },
]

/**
 * addFixedLabels labels the issue with the command's fixed labels
 *
 * @param context - the github actions event context
 * @param cmd - the command definition
 */
export async function addFixedLabels(context: Context, cmd: FixedLabelCommand): Promise<void> {
  const token = core.getInput('github-token', { required: true })
  const octokit = newOctokit(token)

  await labelIssue(octokit, context, requireIssueNumber(context), cmd.add)
}

/**
 * removeFixedLabels removes the command's fixed labels that are on the issue
 *
 * @param context - the github actions event context
 * @param cmd - the command definition
 */
export async function removeFixedLabels(context: Context, cmd: FixedLabelCommand): Promise<void> {
  const token = core.getInput('github-token', { required: true })
  const octokit = newOctokit(token)
  const issueNumber = requireIssueNumber(context)

  let currentLabels: string[] = []
  try {
    currentLabels = await getCurrentLabels(octokit, context, issueNumber)
    core.debug(`${cmd.command.slice(1)}: found labels for issue ${currentLabels}`)
  }
  catch (e) {
    throw new Error(`could not get labels from issue: ${e}`)
  }

  const present = currentLabels.filter(label => cmd.remove.some(requested => sameLabel(requested, label)))

  if (present.length === 0) {
    core.debug(`${cmd.command.slice(1)}: none of ${cmd.remove} are on the issue`)
    return
  }

  await removeLabels(octokit, context, issueNumber, present)
}

function requireIssueNumber(context: Context): number {
  const issueNumber: number | undefined = context.payload.issue?.number

  if (issueNumber === undefined) {
    throw new Error(
      `github context payload missing issue number: ${context.payload}`,
    )
  }

  return issueNumber
}
