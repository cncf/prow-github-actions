import type { Context } from '@actions/github/lib/context'
import * as core from '@actions/core'
import * as github from '@actions/github'

import { checkCollaborator } from '../utils/auth'
import { getCommandArgs } from '../utils/command'
import { newOctokit } from '../utils/octokit'

/**
 * /lock will lock the issue / PR.
 * No more comments will be permitted
 *
 * @param context - the github actions event context
 */
export async function lock(context: Context = github.context): Promise<void> {
  const token = core.getInput('github-token', { required: true })
  const octokit = newOctokit(token)

  const issueNumber: number | undefined = context.payload.issue?.number
  const commenterId: string = context.payload.comment?.user?.login
  const commentBody: string = context.payload.comment?.body

  if (issueNumber === undefined) {
    throw new Error(
      `github context payload missing issue number: ${context.payload}`,
    )
  }

  const commentArgs: string[] = getCommandArgs('/lock', commentBody)

  // Only users who:
  // - are collaborators
  let isAuthUser: boolean = false
  try {
    isAuthUser = await checkCollaborator(octokit, context, commenterId)
  }
  catch (e) {
    throw new Error(`could not check commenter auth: ${e}`)
  }

  if (isAuthUser) {
    if (commentArgs.length > 0) {
      switch (commentArgs[0]) {
        case 'resolved':
          try {
            await octokit.issues.lock({
              ...context.repo,
              issue_number: issueNumber,
            })
          }
          catch (e) {
            throw new Error(`could not lock issue: ${e}`)
          }
          break

        case 'off-topic':
          try {
            await octokit.issues.lock({
              ...context.repo,
              issue_number: issueNumber,
              lock_reason: 'off-topic',
            })
          }
          catch (e) {
            throw new Error(`could not lock issue: ${e}`)
          }
          break

        case 'too-heated':
          try {
            await octokit.issues.lock({
              ...context.repo,
              issue_number: issueNumber,
              lock_reason: 'too heated',
            })
          }
          catch (e) {
            throw new Error(`could not lock issue: ${e}`)
          }
          break

        case 'spam':
          try {
            await octokit.issues.lock({
              ...context.repo,
              issue_number: issueNumber,
              lock_reason: 'spam',
            })
          }
          catch (e) {
            throw new Error(`could not lock issue: ${e}`)
          }
          break

        default:
          try {
            await octokit.issues.lock({
              ...context.repo,
              issue_number: issueNumber,
            })
          }
          catch (e) {
            throw new Error(`could not lock issue: ${e}`)
          }
          break
      }
    }
    else {
      try {
        await octokit.issues.lock({
          ...context.repo,
          issue_number: issueNumber,
        })
      }
      catch (e) {
        throw new Error(`could not lock issue: ${e}`)
      }
    }
  }
  else {
    throw new Error(`commenter is not a collaborator user`)
  }
}
