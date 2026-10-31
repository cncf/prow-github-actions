import type { Context } from '../utils/context'

import { platform } from '../platform'
import { checkCollaborator } from '../utils/auth'
import { getCommandArgs } from '../utils/command'
import { loadProwConfig, resolveHoldLabel } from '../utils/config'
import { getCurrentLabels, removeLabels } from '../utils/labeling'
import { newOctokitFromInputs } from '../utils/octokit'
import { isProtectedLabel, sameLabel } from './prefixed'

/**
 * /remove will remove a label based on the command argument.
 * Labels owned by their own, separately authorized commands (lgtm, approved,
 * the hold label and do-not-merge/*) are refused: those are released with
 * /lgtm cancel, /approve cancel and /hold cancel.
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

  const requested: string[] = getCommandArgs('/remove', commentBody)

  // no arguments after command provided
  if (requested.length === 0) {
    throw new Error(`remove: command args missing from body`)
  }

  const { hold } = await loadProwConfig(octokit, context)
  const offender = requested.find(label => isProtectedLabel(label, [resolveHoldLabel(hold)]))
  if (offender !== undefined) {
    throw new Error(
      `remove: ${offender} is managed by its own command and cannot be removed with /remove; use /lgtm cancel, /approve cancel or /hold cancel`,
    )
  }

  let currentLabels: string[] = []
  try {
    currentLabels = await getCurrentLabels(octokit, context, issueNumber)
    platform().log.debug(`remove: found labels for issue ${currentLabels}`)
  }
  catch (e) {
    throw new Error(`could not get labels from issue: ${e}`)
  }

  // GitHub label names are case-insensitive: remove the issue's own spelling
  const toRemove = currentLabels.filter(label => requested.some(name => sameLabel(name, label)))

  if (toRemove.length === 0) {
    throw new Error(`remove: none of ${requested.join(', ')} are on the issue`)
  }

  await removeLabels(octokit, context, issueNumber, toRemove)
}
