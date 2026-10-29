import type { Context } from '../utils/context'

import { platform } from '../platform'
import { checkCollaborator } from '../utils/auth'
import { getLineArgs } from '../utils/command'
import { newOctokitFromInputs } from '../utils/octokit'

/**
 * /retitle will "rename" the issue / PR.
 * Note - it is expected that the command has an argument with the new title
 *
 * @param context - the github actions event context
 */
export async function retitle(
  context: Context = platform().context(),
): Promise<void> {
  const octokit = newOctokitFromInputs()

  const issueNumber: number | undefined = context.payload.issue?.number
  const commenterId: string = context.payload.comment?.user?.login
  const commentBody: string = context.payload.comment?.body

  if (issueNumber === undefined) {
    throw new Error(
      `github context payload missing issue number: ${JSON.stringify(context.payload)}`,
    )
  }

  const title: string = getLineArgs('/retitle', commentBody)

  // no arguments after command provided. Can't retitle!
  if (title === '') {
    return
  }

  // Only users who:
  // - are collaborators
  const isAuthUser = await checkCollaborator(octokit, context, commenterId)

  if (isAuthUser) {
    try {
      await octokit.issues.update({
        ...context.repo,
        issue_number: issueNumber,
        title,
      })
    }
    catch (e) {
      throw new Error(`could not update issue: ${e}`)
    }
  }
}
