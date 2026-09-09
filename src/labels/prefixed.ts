import type { Context } from '@actions/github/lib/context'
import type { Octokit } from '@octokit/rest'
import * as core from '@actions/core'

import { getCommandArgs } from '../utils/command'
import { addPrefix, getArgumentLabels, getCurrentLabels, labelIssue, removeLabels } from '../utils/labeling'
import { newOctokit } from '../utils/octokit'

export interface PrefixedLabelCommand {
  /** the slash command, ex: '/kind' */
  command: string
  /** label prefix, ex: 'kind' yields 'kind/<value>'; '' applies labels verbatim */
  prefix: string
  /** top level key in .prowlabels.yaml listing the allowed values */
  allowlistKey: string
  /** replace any existing '<prefix>/*' labels instead of stacking them */
  exclusive?: boolean
}

export const prefixedLabelCommands: PrefixedLabelCommand[] = [
  { command: '/area', prefix: 'area', allowlistKey: 'area' },
  { command: '/kind', prefix: 'kind', allowlistKey: 'kind' },
  { command: '/priority', prefix: 'priority', allowlistKey: 'priority', exclusive: true },
  { command: '/label', prefix: '', allowlistKey: 'labels' },
]

/**
 * removeCommandFor returns the Prow-style removal spelling of a label command
 * Ex: '/kind' -> '/remove-kind'
 *
 * @param command - the add form of the command
 */
export function removeCommandFor(command: string): string {
  return `/remove-${command.slice(1)}`
}

/**
 * addPrefixedLabels labels the issue with '<prefix>/<value>' for every value
 * that is both in the comment and in the .prowlabels.yaml allowlist.
 * When the command is exclusive, existing '<prefix>/*' labels that were not
 * requested are removed first.
 *
 * @param context - the github actions event context
 * @param cmd - the command definition
 */
export async function addPrefixedLabels(context: Context, cmd: PrefixedLabelCommand): Promise<void> {
  const token = core.getInput('github-token', { required: true })
  const octokit = newOctokit(token)

  const issueNumber = requireIssueNumber(context)
  const commentBody: string = context.payload.comment?.body

  const labels = await requestedLabels(octokit, context, cmd, cmd.command, commentBody)

  if (cmd.exclusive) {
    const currentLabels = await currentIssueLabels(octokit, context, issueNumber, cmd.command)

    const stale = currentLabels.filter((label) => {
      return label.startsWith(`${cmd.prefix}/`) && !labels.includes(label)
    })

    if (stale.length > 0) {
      await removeLabels(octokit, context, issueNumber, stale)
    }
  }

  await labelIssue(octokit, context, issueNumber, labels)
}

/**
 * removePrefixedLabels removes '<prefix>/<value>' for every value in the
 * /remove-<command> line that is in the .prowlabels.yaml allowlist and
 * currently on the issue. Restricting removal to the allowlist keeps
 * anyone from stripping protected labels such as lgtm, approved or hold.
 *
 * @param context - the github actions event context
 * @param cmd - the command definition
 */
export async function removePrefixedLabels(context: Context, cmd: PrefixedLabelCommand): Promise<void> {
  const token = core.getInput('github-token', { required: true })
  const octokit = newOctokit(token)

  const issueNumber = requireIssueNumber(context)
  const commentBody: string = context.payload.comment?.body
  const command = removeCommandFor(cmd.command)

  const labels = await requestedLabels(octokit, context, cmd, command, commentBody)
  const currentLabels = await currentIssueLabels(octokit, context, issueNumber, command)

  const present = labels.filter(label => currentLabels.includes(label))

  if (present.length === 0) {
    core.debug(`${command.slice(1)}: none of ${labels} are on the issue`)
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

async function requestedLabels(
  octokit: Octokit,
  context: Context,
  cmd: PrefixedLabelCommand,
  command: string,
  commentBody: string,
): Promise<string[]> {
  const name = command.slice(1)
  const args = getCommandArgs(command, commentBody)

  let allowed: string[] = []
  try {
    allowed = await getArgumentLabels(octokit, context, cmd.allowlistKey)
    core.debug(`${name}: found labels ${allowed}`)
  }
  catch (e) {
    throw new Error(`could not get labels from yaml: ${e}`)
  }

  const labels = addPrefix(cmd.prefix, args.filter(arg => allowed.includes(arg)))

  // no arguments after command provided
  if (labels.length === 0) {
    throw new Error(`${name}: command args missing from body`)
  }

  return labels
}

async function currentIssueLabels(
  octokit: Octokit,
  context: Context,
  issueNumber: number,
  command: string,
): Promise<string[]> {
  try {
    const currentLabels = await getCurrentLabels(octokit, context, issueNumber)
    core.debug(`${command.slice(1)}: found labels for issue ${currentLabels}`)
    return currentLabels
  }
  catch (e) {
    throw new Error(`could not get labels from issue: ${e}`)
  }
}
