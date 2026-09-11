import type { Context } from '../utils/context'
import * as core from '@actions/core'
import * as github from '@actions/github'

import { checkCommenterAuth } from '../utils/auth'
import { getCommandArgs } from '../utils/command'
import { newOctokit } from '../utils/octokit'

/**
 * /unassign will remove the assignment for argument users (or self)
 *
 * @param context - the github actions event context
 */
export async function unassign(
  context: Context = github.context,
): Promise<void> {
  const token = core.getInput('github-token', { required: true })
  const octokit = newOctokit(token)

  const issueNumber: number | undefined = context.payload.issue?.number
  const commenterId: string = context.payload.comment?.user?.login
  const commentBody: string = context.payload.comment?.body

  if (issueNumber === undefined) {
    throw new Error(
      `github context payload missing issue number: ${context.payload}`,
    )
  }

  const commentArgs: string[] = getCommandArgs('/unassign', commentBody)

  // no arguments after command provided
  if (commentArgs.length === 0) {
    try {
      await octokit.issues.removeAssignees({
        ...context.repo,
        issue_number: issueNumber,
        assignees: [commenterId],
      })
    }
    catch (e) {
      throw new Error(`could not remove assignee: ${e}`)
    }

    return
  }

  let isAuthUser: boolean = false
  try {
    isAuthUser = await checkCommenterAuth(
      octokit,
      context,
      issueNumber,
      commenterId,
    )
  }
  catch (e) {
    throw new Error(`couldn ot check commentor Auth: ${e}`)
  }

  if (isAuthUser) {
    try {
      await octokit.issues.removeAssignees({
        ...context.repo,
        issue_number: issueNumber,
        assignees: commentArgs,
      })
    }
    catch (e) {
      throw new Error(`could not remove assignee: ${e}`)
    }
  }
}
