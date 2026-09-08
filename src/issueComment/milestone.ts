import type { Context } from '@actions/github/lib/context'
import * as core from '@actions/core'

import * as github from '@actions/github'

import { checkCollaborator } from '../utils/auth'
import { getLineArgs } from '../utils/command'
import { newOctokit } from '../utils/octokit'

/**
 * /milestone will add the issue to an existing milestone.
 * Note that the command should have an argument with the milestone to add
 *
 * @param context - the github actions event context
 */
export async function milestone(
  context: Context = github.context,
): Promise<void> {
  const token = core.getInput('github-token', { required: true })
  const octokit = newOctokit(token)

  const issueNumber: number | undefined = context.payload.issue?.number
  const commentBody: string = context.payload.comment?.body
  const commenterId: string = context.payload.comment?.user?.login

  if (issueNumber === undefined) {
    throw new Error(
      `github context payload missing issue number: ${context.payload}`,
    )
  }

  // Only users who:
  // - are collaborators
  let isAuthUser: boolean = false
  try {
    isAuthUser = await checkCollaborator(octokit, context, commenterId)
  }
  catch (e) {
    throw new Error(`could not check commenter auth: ${e}`)
  }

  if (!isAuthUser) {
    throw new Error(
      `commenter is not authorized to set a milestone. Must be repo collaborator`,
    )
  }

  const milestoneToAdd: string = getLineArgs('/milestone', commentBody)

  if (milestoneToAdd === '') {
    throw new Error(`please provide a milestone to add`)
  }

  const ms = await octokit.issues.listMilestones({
    ...context.repo,
  })

  for (const m of ms.data) {
    if (m.title === milestoneToAdd) {
      await octokit.issues.update({
        ...context.repo,
        issue_number: issueNumber,
        milestone: m.number,
      })
    }
  }
}
