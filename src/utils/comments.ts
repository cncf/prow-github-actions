import type { Octokit } from '@octokit/rest'
import type { Context } from './context'

import * as core from '@actions/core'

interface BotComment {
  id: number
  body?: string | null
  user?: { login?: string, type?: string } | null
}

/**
 * createComment comments on the specified issue or pull request
 *
 * @param octokit - a hydrated github client
 * @param context - the github actions event context
 * @param issueNum - the issue associated with this runtime
 * @param message - the comment message body
 */
export async function createComment(
  octokit: Octokit,
  context: Context,
  issueNum: number,
  message: string,
): Promise<void> {
  try {
    await octokit.issues.createComment({
      ...context.repo,
      issue_number: issueNum,
      body: message,
    })
  }
  catch (e) {
    throw new Error(`could not add comment: ${e}`)
  }
}

/**
 * createCommentOnce posts `message` with `marker` (an invisible HTML comment)
 * appended, unless a bot comment carrying the marker already exists: one
 * explanation per fact, however many runs observe it.
 *
 * @param octokit - a hydrated github client
 * @param context - the github actions event context
 * @param issueNum - the issue or pull request
 * @param marker - what identifies this explanation, ex: `<!-- prow-github-actions/x: sha7 -->`
 * @param message - the comment message body
 * @returns whether a comment was posted
 */
export async function createCommentOnce(
  octokit: Octokit,
  context: Context,
  issueNum: number,
  marker: string,
  message: string,
): Promise<boolean> {
  const comments: BotComment[] = await octokit.paginate(octokit.issues.listComments, { ...context.repo, issue_number: issueNum, per_page: 100 })
  if (comments.some(comment => isBotUser(comment.user) && (comment.body ?? '').includes(marker))) {
    core.debug(`#${issueNum} already carries ${marker}`)
    return false
  }
  await createComment(octokit, context, issueNum, `${message}\n\n${marker}`)
  return true
}

export function isBotUser(user: { login?: string, type?: string } | null | undefined): boolean {
  return user?.type === 'Bot' || user?.login === 'github-actions[bot]'
}
