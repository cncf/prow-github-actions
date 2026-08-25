import type { Context } from '@actions/github/lib/context'
import * as core from '@actions/core'

import * as github from '@actions/github'
import { Octokit } from '@octokit/rest'

import { assertAuthorizedByOwnersOrMembership } from '../utils/auth'
import { getCommandArgs } from '../utils/command'
import { createComment } from '../utils/comments'
import { cancelLabel, labelIssue } from '../utils/labeling'

/**
 * /lgtm will add the lgtm label.
 * Note - this label is used to indicate automatic merging
 * if the user has configured a cron job to perform automatic merging
 *
 * @param context - the github actions event context
 */
export async function lgtm(context: Context = github.context): Promise<void> {
  const token = core.getInput('github-token', { required: true })
  const octokit = new Octokit({
    auth: token,
  })

  const issueNumber: number | undefined = context.payload.issue?.number
  const commentBody: string = context.payload.comment?.body
  const commenterId: string = context.payload.comment?.user?.login

  if (issueNumber === undefined) {
    throw new Error(
      `github context payload missing issue number: ${context.payload}`,
    )
  }

  try {
    await assertAuthorizedByOwnersOrMembership(
      octokit,
      context,
      'reviewers',
      commenterId,
    )
  }
  catch (e) {
    const msg = `Cannot apply the lgtm label because ${e}`
    core.error(msg)

    // Try to reply back that the user is unauthorized
    try {
      await createComment(octokit, context, issueNumber, msg)
    }
    catch (commentE) {
      // Log the comment error but continue to throw the original auth error
      core.error(`Could not comment with an auth error: ${commentE}`)
    }
    throw e
  }

  const commentArgs: string[] = getCommandArgs('/lgtm', commentBody)

  // check if canceling last review
  if (commentArgs.length !== 0 && commentArgs[0] === 'cancel') {
    try {
      await cancelLabel(octokit, context, issueNumber, 'lgtm')
    }
    catch (e) {
      throw new Error(`could not remove latest review: ${e}`)
    }
    return
  }

  await labelIssue(octokit, context, issueNumber, ['lgtm'])
}
