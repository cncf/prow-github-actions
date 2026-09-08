import type { Context } from '@actions/github/lib/context'
import * as core from '@actions/core'

import * as github from '@actions/github'

import { getCommandArgs } from '../utils/command'
import { addPrefix, getArgumentLabels, getCurrentLabels, labelIssue, removeLabels } from '../utils/labeling'
import { newOctokit } from '../utils/octokit'

/**
 * /priority will add a priority/some-priority label, replacing any existing
 * priority/* labels so an issue keeps only the newly requested set.
 *
 * @param context - the github actions event context
 */
export async function priority(context: Context = github.context): Promise<void> {
  const token = core.getInput('github-token', { required: true })
  const octokit = newOctokit(token)

  const issueNumber: number | undefined = context.payload.issue?.number
  const commentBody: string = context.payload.comment?.body

  if (issueNumber === undefined) {
    throw new Error(
      `github context payload missing issue number: ${context.payload}`,
    )
  }

  let commentArgs: string[] = getCommandArgs('/priority', commentBody)

  let priorityLabels: string[] = []
  try {
    priorityLabels = await getArgumentLabels(octokit, context, 'priority')
    core.debug(`priority: found labels ${priorityLabels}`)
  }
  catch (e) {
    throw new Error(`could not get labels from yaml: ${e}`)
  }

  commentArgs = commentArgs.filter((e) => {
    return priorityLabels.includes(e)
  })

  commentArgs = addPrefix('priority', commentArgs)

  // no arguments after command provided
  if (commentArgs.length === 0) {
    throw new Error(`priority: command args missing from body`)
  }

  let currentLabels: string[] = []
  try {
    currentLabels = await getCurrentLabels(octokit, context, issueNumber)
    core.debug(`priority: found labels for issue ${currentLabels}`)
  }
  catch (e) {
    throw new Error(`could not get labels from issue: ${e}`)
  }

  const stalePriorityLabels = currentLabels.filter((label) => {
    return label.startsWith('priority/') && !commentArgs.includes(label)
  })

  if (stalePriorityLabels.length > 0) {
    await removeLabels(octokit, context, issueNumber, stalePriorityLabels)
  }

  await labelIssue(octokit, context, issueNumber, commentArgs)
}
