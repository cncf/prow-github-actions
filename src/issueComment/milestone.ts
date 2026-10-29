import type { Context } from '../utils/context'

import { platform } from '../platform'
import { checkCollaborator } from '../utils/auth'
import { getLineArgs } from '../utils/command'
import { newOctokitFromInputs } from '../utils/octokit'

/**
 * /milestone will add the issue to an existing milestone.
 * Note that the command should have an argument with the milestone to add.
 * /milestone clear removes the issue from its milestone.
 *
 * @param context - the github actions event context
 */
export async function milestone(
  context: Context = platform().context(),
): Promise<void> {
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
      `commenter is not authorized to set a milestone. Must be repo collaborator`,
    )
  }

  const milestoneToAdd: string = getLineArgs('/milestone', commentBody)

  if (milestoneToAdd === '') {
    throw new Error(`please provide a milestone to add`)
  }

  if (milestoneToAdd.toLowerCase() === 'clear') {
    await octokit.issues.update({
      ...context.repo,
      issue_number: issueNumber,
      milestone: null,
    })
    return
  }

  const ms = await octokit.issues.listMilestones({
    ...context.repo,
  })

  const match = ms.data.find(m => m.title === milestoneToAdd)

  if (match === undefined) {
    const titles = ms.data.map(m => m.title)
    const available = titles.length === 0 ? 'none' : titles.join(', ')
    throw new Error(
      `milestone "${milestoneToAdd}" not found. Available milestones: ${available}`,
    )
  }

  await octokit.issues.update({
    ...context.repo,
    issue_number: issueNumber,
    milestone: match.number,
  })
}
