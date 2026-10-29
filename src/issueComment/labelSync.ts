import type { Context } from '../utils/context'

import { labelSync } from '../cronJobs/labelSync'
import { platform } from '../platform'
import { checkCollaborator } from '../utils/auth'
import { createComment } from '../utils/comments'
import { newOctokitFromInputs } from '../utils/octokit'

/**
 * /label-sync creates and updates the repository's labels from the prow
 * configuration, as the label-sync job does, on request from a collaborator.
 * It stands in for the action's "Run workflow" button where there is none.
 *
 * @param context - the github actions event context
 */
export async function labelSyncCommand(context: Context = platform().context()): Promise<void> {
  const octokit = newOctokitFromInputs()
  const issueNumber: number | undefined = context.payload.issue?.number
  const commenterId: string = context.payload.comment?.user?.login
  if (issueNumber === undefined) {
    throw new Error(`github context payload missing issue number: ${JSON.stringify(context.payload)}`)
  }

  if (!(await checkCollaborator(octokit, context, commenterId))) {
    await createComment(octokit, context, issueNumber, `@${commenterId}: only collaborators may run \`/label-sync\`.`)
    return
  }

  // labelSync throws when a write was refused; the comment reports a clean run
  const result = await labelSync(context)
  const lines = [`label-sync: created ${result.created.length}, updated ${result.updated.length}, unchanged ${result.unchanged}.`]
  if (result.created.length > 0) {
    lines.push(`Created: ${result.created.map(name => `\`${name}\``).join(', ')}`)
  }
  if (result.updated.length > 0) {
    lines.push(`Updated: ${result.updated.map(name => `\`${name}\``).join(', ')}`)
  }
  await createComment(octokit, context, issueNumber, lines.join('\n'))
}
