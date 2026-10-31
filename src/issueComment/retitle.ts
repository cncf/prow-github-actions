import type { Context } from '../utils/context'

import { platform } from '../platform'
import { checkCollaborator } from '../utils/auth'
import { getLineArgs } from '../utils/command'
import { newOctokitFromInputs } from '../utils/octokit'

const MAX_TITLE_LENGTH = 256

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

  if (title === '') {
    throw new Error(`please provide a new title: /retitle <title>`)
  }
  // GitHub refuses a longer title with an opaque validation error
  if (title.length > MAX_TITLE_LENGTH) {
    throw new Error(`the new title is ${title.length} characters long, at most ${MAX_TITLE_LENGTH} are allowed`)
  }

  // Only users who:
  // - are collaborators
  const isAuthUser = await checkCollaborator(octokit, context, commenterId)

  if (!isAuthUser) {
    throw new Error(
      `${commenterId} is not authorized to retitle this issue. Must be repo collaborator`,
    )
  }

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
