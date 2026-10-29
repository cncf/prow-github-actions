import type { Context } from '../utils/context'

import { platform } from '../platform'
import { checkCollaborator } from '../utils/auth'
import { getCommandArgs } from '../utils/command'
import { getCurrentLabels, removeLabels } from '../utils/labeling'
import { newOctokitFromInputs } from '../utils/octokit'

/**
 * /remove will remove a label based on the command argument
 *
 * @param context - the github actions event context
 */
export async function remove(context: Context = platform().context()): Promise<void> {
  const octokit = newOctokitFromInputs()

  const issueNumber: number | undefined = context.payload.issue?.number
  const commentBody: string = context.payload.comment?.body
  const commenterId: string = context.payload.comment?.user?.login

  if (issueNumber === undefined) {
    throw new Error(
      `github context payload missing issue number: ${JSON.stringify(context.payload)}`,
    )
  }

  // Only users who:
  // - are collaborators
  const isAuthUser = await checkCollaborator(octokit, context, commenterId)

  if (!isAuthUser) {
    throw new Error(
      `commenter is not authorized to remove a label. Must be repo collaborator`,
    )
  }

  let toRemove: string[] = getCommandArgs('/remove', commentBody)

  let currentLabels: string[] = []
  try {
    currentLabels = await getCurrentLabels(octokit, context, issueNumber)
    platform().log.debug(`remove: found labels for issue ${currentLabels}`)
  }
  catch (e) {
    throw new Error(`could not get labels from issue: ${e}`)
  }

  toRemove = toRemove.filter((e) => {
    return currentLabels.includes(e)
  })

  // no arguments after command provided
  if (toRemove.length === 0) {
    throw new Error(`remove: command args missing from body`)
  }

  await removeLabels(octokit, context, issueNumber, toRemove)
}
