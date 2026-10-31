import type { Context } from '../utils/context'

import { platform } from '../platform'
import { checkCollaborator, checkOrgMember } from '../utils/auth'
import { getCommandArgs } from '../utils/command'
import { newOctokitFromInputs } from '../utils/octokit'

/**
 * /unassign will remove the assignment for argument users (or self)
 *
 * @param context - the github actions event context
 */
export async function unassign(
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

  const commentArgs: string[] = getCommandArgs('/unassign', commentBody)

  // no arguments after command provided
  if (commentArgs.length === 0) {
    try {
      await octokit.issues.removeAssignees({
        ...context.repo,
        issue_number: issueNumber,
        assignees: [commenterId],
      })
    }
    catch (e) {
      throw new Error(`could not remove assignee: ${e}`)
    }

    return
  }

  // Only a commenter who is an org member or a repo collaborator may unassign
  // other users; having commented on the issue is not enough
  const isOrgMember = await checkOrgMember(octokit, context, commenterId)
  const isCollaborator = await checkCollaborator(octokit, context, commenterId)

  if (!isOrgMember && !isCollaborator) {
    platform().log.info(`unassign: ${commenterId} is not an org member or repo collaborator; not unassigning ${commentArgs.join(', ')}`)
    return
  }

  try {
    await octokit.issues.removeAssignees({
      ...context.repo,
      issue_number: issueNumber,
      assignees: commentArgs,
    })
  }
  catch (e) {
    throw new Error(`could not remove assignee: ${e}`)
  }
}
