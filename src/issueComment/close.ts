import type { Context } from '../utils/context'
import * as core from '@actions/core'
import * as github from '@actions/github'

import { checkCollaborator } from '../utils/auth'
import { getCommandArgs, hasKeyword } from '../utils/command'
import { newOctokit } from '../utils/octokit'

/**
 * /close will close the issue / PR.
 * /close not-planned closes it with the not_planned state reason
 *
 * @param context - the github actions event context
 */
export async function close(context: Context = github.context): Promise<void> {
  const token = core.getInput('github-token', { required: true })
  const octokit = newOctokit(token)

  const issueNumber: number | undefined = context.payload.issue?.number
  const commentBody: string = context.payload.comment?.body
  const commenterId: string = context.payload.comment?.user?.login

  if (issueNumber === undefined) {
    throw new Error(
      `github context payload missing issue number: ${context.payload}`,
    )
  }

  // Only users who:
  // - are the issue / PR author
  // - are collaborators
  const isAuthor = commenterId === context.payload.issue?.user?.login
  let isAuthUser: boolean = isAuthor
  if (!isAuthor) {
    try {
      isAuthUser = await checkCollaborator(octokit, context, commenterId)
    }
    catch (e) {
      throw new Error(`could not check commentor auth: ${e}`)
    }
  }

  if (isAuthUser) {
    const notPlanned = hasKeyword(getCommandArgs('/close', commentBody), 'not-planned')

    try {
      if (notPlanned) {
        await octokit.issues.update({
          ...context.repo,
          issue_number: issueNumber,
          state: 'closed',
          state_reason: 'not_planned',
        })
      }
      else {
        await octokit.issues.update({
          ...context.repo,
          issue_number: issueNumber,
          state: 'closed',
        })
      }
    }
    catch (e) {
      throw new Error(`could not close issue: ${e}`)
    }
  }
}
