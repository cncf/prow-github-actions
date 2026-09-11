import type { Octokit } from '@octokit/rest'
import type { Context } from '../utils/context'
import * as core from '@actions/core'

import * as github from '@actions/github'

import { assertAuthorizedByOwnersOrMembership } from '../utils/auth'
import { getCommandArgs, hasCommand, hasKeyword } from '../utils/command'
import { createComment } from '../utils/comments'
import { cancelLabel, labelIssue } from '../utils/labeling'
import { newOctokit } from '../utils/octokit'

/**
 * /lgtm will add the lgtm label.
 * /lgtm cancel and /remove-lgtm remove it.
 * Like Prow, the author cannot lgtm their own PR but may cancel an lgtm on it.
 * Note - this label is used to indicate automatic merging
 * if the user has configured a cron job to perform automatic merging
 *
 * @param context - the github actions event context
 */
export async function lgtm(context: Context = github.context): Promise<void> {
  const token = core.getInput('github-token', { required: true })
  const octokit = newOctokit(token)

  const issueNumber: number | undefined = context.payload.issue?.number
  const commentBody: string = context.payload.comment?.body
  const commenterId: string = context.payload.comment?.user?.login
  const isAuthor = commenterId === context.payload.issue?.user?.login

  if (issueNumber === undefined) {
    throw new Error(
      `github context payload missing issue number: ${context.payload}`,
    )
  }

  const cancel = hasCommand('/remove-lgtm', commentBody)
    || (hasCommand('/lgtm', commentBody) && hasKeyword(getCommandArgs('/lgtm', commentBody), 'cancel'))

  if (cancel) {
    if (!isAuthor) {
      await assertReviewer(octokit, context, issueNumber, commenterId)
    }

    try {
      await cancelLabel(octokit, context, issueNumber, 'lgtm')
    }
    catch (e) {
      throw new Error(`could not remove latest review: ${e}`)
    }
    return
  }

  if (isAuthor) {
    await refuse(octokit, context, issueNumber, 'you cannot LGTM your own PR.')
  }

  await assertReviewer(octokit, context, issueNumber, commenterId)

  await labelIssue(octokit, context, issueNumber, ['lgtm'])
}

async function assertReviewer(
  octokit: Octokit,
  context: Context,
  issueNumber: number,
  commenterId: string,
): Promise<void> {
  try {
    await assertAuthorizedByOwnersOrMembership(
      octokit,
      context,
      'reviewers',
      commenterId,
    )
  }
  catch (e) {
    await refuse(octokit, context, issueNumber, `Cannot apply the lgtm label because ${e}`, e)
  }
}

// refuse logs and replies with msg, then fails the run with cause (or msg)
async function refuse(
  octokit: Octokit,
  context: Context,
  issueNumber: number,
  msg: string,
  cause: unknown = new Error(msg),
): Promise<never> {
  core.error(msg)

  try {
    await createComment(octokit, context, issueNumber, msg)
  }
  catch (commentE) {
    core.error(`Could not comment with an auth error: ${commentE}`)
  }
  throw cause
}
