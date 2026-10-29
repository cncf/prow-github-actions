import type { Context } from '../utils/context'

import { platform } from '../platform'
import { checkCollaborator, closePolicyAllows } from '../utils/auth'
import { newOctokitFromInputs } from '../utils/octokit'

/**
 * /reopen will reopen the issue / PR. May be called after /close
 *
 * @param context - the github actions event context
 */
export async function reopen(context: Context = platform().context()): Promise<void> {
  const octokit = newOctokitFromInputs()

  const issueNumber: number | undefined = context.payload.issue?.number
  const commenterId: string = context.payload.comment?.user?.login

  if (issueNumber === undefined) {
    throw new Error(
      `github context payload missing issue number: ${JSON.stringify(context.payload)}`,
    )
  }

  // Only users who:
  // - are the issue / PR author
  // - are collaborators
  // - pass `authorization.close`, which is read only when the first two refuse
  const isAuthor = commenterId === context.payload.issue?.user?.login
  const isAuthUser
    = isAuthor
      || (await checkCollaborator(octokit, context, commenterId))
      || (await closePolicyAllows(octokit, context, commenterId))

  if (isAuthUser) {
    try {
      await octokit.issues.update({
        ...context.repo,
        issue_number: issueNumber,
        state: 'open',
      })
    }
    catch (e) {
      throw new Error(`could not open issue: ${e}`)
    }
  }
}
