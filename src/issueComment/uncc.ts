import type { Octokit } from '@octokit/rest'
import type { Context } from '../utils/context'

import { platform } from '../platform'
import { checkCollaborator, checkOrgMember } from '../utils/auth'
import { getCommandArgs } from '../utils/command'
import { newOctokitFromInputs } from '../utils/octokit'

/**
 * /uncc will remove the review request for argument users (or self)
 *
 * @param context - the github actions event context
 */
export async function uncc(context: Context = platform().context()): Promise<void> {
  const octokit = newOctokitFromInputs()

  const pullNumber: number | undefined = context.payload.issue?.number
  const commenterId: string = context.payload.comment?.user?.login
  const commentBody: string = context.payload.comment?.body

  if (pullNumber === undefined) {
    throw new Error(
      `github context payload missing pull number: ${JSON.stringify(context.payload)}`,
    )
  }

  const commentArgs: string[] = getCommandArgs('/uncc', commentBody)

  // no arguments after command provided
  if (commentArgs.length === 0) {
    try {
      await removeSelfReviewReq(octokit, context, pullNumber, commenterId)
    }
    catch (e) {
      throw new Error(`could not self uncc: ${e}`)
    }
    return
  }

  // Only a commenter who is an org member or a repo collaborator may remove
  // other users' review requests; having commented on the PR is not enough
  const isOrgMember = await checkOrgMember(octokit, context, commenterId)
  const isCollaborator = await checkCollaborator(octokit, context, commenterId)

  if (!isOrgMember && !isCollaborator) {
    platform().log.info(`uncc: ${commenterId} is not an org member or repo collaborator; not removing ${commentArgs.join(', ')}`)
    return
  }

  await octokit.pulls.removeRequestedReviewers({
    ...context.repo,
    pull_number: pullNumber,
    reviewers: commentArgs,
  })
}

/**
 * removeSelfReviewReq will remove the self review req if no arguments were provided
 *
 * @param octokit - a hydrated github client
 * @param context - the github actions event context
 * @param pullNum - the pr number this runtime is associated with
 * @param user - the user to self assign
 */
async function removeSelfReviewReq(
  octokit: Octokit,
  context: Context,
  pullNum: number,
  user: string,
): Promise<void> {
  const isCollaborator = await checkCollaborator(octokit, context, user)

  if (isCollaborator) {
    await octokit.pulls.removeRequestedReviewers({
      ...context.repo,
      pull_number: pullNum,
      reviewers: [user],
    })
  }
}
