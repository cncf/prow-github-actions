import type { Context } from '@actions/github/lib/context'
import * as core from '@actions/core'

import * as github from '@actions/github'

import { getCommandArgs, hasCommand } from '../utils/command'
import { cancelLabel, labelIssue } from '../utils/labeling'
import { newOctokit } from '../utils/octokit'

/**
 * /hold will add the hold label.
 * /hold cancel, /unhold and /remove-hold remove it.
 * Note - the hold label will block automatic merging if the lgtm
 * is also present
 *
 * @param context - the github actions event context
 */
export async function hold(context: Context = github.context): Promise<void> {
  const token = core.getInput('github-token', { required: true })
  const octokit = newOctokit(token)

  const issueNumber: number | undefined = context.payload.issue?.number
  const commentBody: string = context.payload.comment?.body

  if (issueNumber === undefined) {
    throw new Error(
      `github context payload missing issue number: ${context.payload}`,
    )
  }

  const cancel = hasCommand('/unhold', commentBody)
    || hasCommand('/remove-hold', commentBody)
    || (hasCommand('/hold', commentBody) && getCommandArgs('/hold', commentBody).includes('cancel'))

  if (cancel) {
    try {
      await cancelLabel(octokit, context, issueNumber, 'hold')
    }
    catch (e) {
      throw new Error(`could not remove the hold label: ${e}`)
    }
    return
  }

  await labelIssue(octokit, context, issueNumber, ['hold'])
}
