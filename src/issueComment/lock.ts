import type { Context } from '../utils/context'
import * as core from '@actions/core'
import * as github from '@actions/github'

import { checkCollaborator } from '../utils/auth'
import { getCommandArgs } from '../utils/command'
import { newOctokit } from '../utils/octokit'

type LockReason = 'off-topic' | 'too heated' | 'resolved' | 'spam'

const lockReasons: Record<string, LockReason> = {
  'resolved': 'resolved',
  'off-topic': 'off-topic',
  'too-heated': 'too heated',
  'spam': 'spam',
}

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
    let lockReason: LockReason | undefined
    if (commentArgs.length > 0) {
      const arg = commentArgs[0].toLowerCase()
      lockReason = lockReasons[arg]
      if (lockReason === undefined) {
        throw new Error(`/lock: unknown reason "${commentArgs[0]}". Use resolved, off-topic, too-heated or spam`)
      }
    }

    try {
      await octokit.issues.lock({
        ...context.repo,
        issue_number: issueNumber,
        ...(lockReason !== undefined ? { lock_reason: lockReason } : {}),
      })
    }
    catch (e) {
      throw new Error(`could not lock issue: ${e}`)
    }
  }
  else {
    throw new Error(`commenter is not a collaborator user`)
  }
}
