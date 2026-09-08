import type { Context } from '@actions/github/lib/context'
import * as core from '@actions/core'
import * as github from '@actions/github'

import { checkCollaborator } from '../utils/auth'
import { getCommandArgs } from '../utils/command'
import { newOctokit } from '../utils/octokit'

/**
 * /retitle will "rename" the issue / PR.
 * Note - it is expected that the command has an argument with the new title
 *
 * @param context - the github actions event context
 */
export async function retitle(
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

  const commentArgs: string[] = getCommandArgs('/retitle', commentBody)

  // no arguments after command provided. Can't retitle!
  if (commentArgs.length === 0) {
    return
  }

  // Only users who:
  // - are collaborators
  let isAuthUser: boolean = false
  try {
    isAuthUser = await checkCollaborator(octokit, context, commenterId)
  }
  catch (e) {
    throw new Error(`could not check Commentor auth: ${e}`)
  }

  if (isAuthUser) {
    try {
      await octokit.issues.update({
        ...context.repo,
        issue_number: issueNumber,
        title: commentArgs.join(' '),
      })
    }
    catch (e) {
      throw new Error(`could not update issue: ${e}`)
    }
  }
}
