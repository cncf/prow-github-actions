import type { Context } from '@actions/github/lib/context'
import * as core from '@actions/core'
import * as github from '@actions/github'

import { checkCollaborator } from '../utils/auth'
import { newOctokit } from '../utils/octokit'

/**
 * /reopen will reopen the issue / PR. May be called after /close
 *
 * @param context - the github actions event context
 */
export async function reopen(context: Context = github.context): Promise<void> {
  const token = core.getInput('github-token', { required: true })
  const octokit = newOctokit(token)

  const issueNumber: number | undefined = context.payload.issue?.number
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
    throw new Error(`could not check commentor auth: ${e}`)
  }

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
