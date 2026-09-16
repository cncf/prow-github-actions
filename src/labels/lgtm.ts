import type { Octokit } from '@octokit/rest'
import type { Context } from '../utils/context'
import * as core from '@actions/core'

import * as github from '@actions/github'

import { bindLgtm, lgtmLabel, lgtmSettings, unbindLgtm } from '../plugins/lgtmBinding'
import { assertAuthorizedByOwnersOrMembership } from '../utils/auth'
import { getCommandArgs, hasCommand, hasKeyword } from '../utils/command'
import { createComment } from '../utils/comments'
import { loadProwConfig } from '../utils/config'
import { getCurrentLabels, labelIssue, removeLabels } from '../utils/labeling'
import { newOctokit } from '../utils/octokit'
import { loadPullRequestOwners } from '../utils/pullRequestOwners'

/**
 * /lgtm will add the lgtm label. On a pull request the label is first bound
 * to the head commit with a `prow/lgtm` commit status (`lgtm.bind_to_commit`);
 * the label is applied only once the status is recorded, so no unbound
 * label is ever left behind.
 * /lgtm cancel and /remove-lgtm remove it and void the binding.
 * Like Prow, the author cannot lgtm their own PR but may cancel an lgtm on it.
 * Note - this label is used to indicate automatic merging
 * if the user has configured a cron job to perform automatic merging
 *
 * @param context - the github actions event context
 */
export async function lgtm(context: Context = github.context): Promise<void> {
  const token = core.getInput('github-token', { required: true })
  const octokit = newOctokit(token)

  const issueNumber: number | undefined = context.payload.issue?.number
  const commentBody: string = context.payload.comment?.body
  const commenterId: string = context.payload.comment?.user?.login
  const isAuthor = commenterId === context.payload.issue?.user?.login
  const isPullRequest = context.payload.issue?.pull_request !== undefined

  if (issueNumber === undefined) {
    throw new Error(
      `github context payload missing issue number: ${context.payload}`,
    )
  }

  const cancel = hasCommand('/remove-lgtm', commentBody)
    || (hasCommand('/lgtm', commentBody) && hasKeyword(getCommandArgs('/lgtm', commentBody), 'cancel'))

  if (cancel) {
    if (!isAuthor) {
      await assertReviewer(octokit, context, issueNumber, commenterId)
    }

    await cancelLgtm(octokit, context, issueNumber, commenterId, isPullRequest)
    return
  }

  if (isAuthor) {
    await refuse(octokit, context, issueNumber, 'you cannot LGTM your own PR.')
  }

  await assertReviewer(octokit, context, issueNumber, commenterId)

  if (isPullRequest && (await bindsToCommit(octokit, context))) {
    const { headSha } = await loadPullRequestOwners(octokit, context, issueNumber)
    try {
      await bindLgtm(octokit, context, headSha, commenterId, context.payload.comment?.html_url)
    }
    catch (e) {
      await refuse(octokit, context, issueNumber, e instanceof Error ? e.message : String(e), e)
    }
  }

  await labelIssue(octokit, context, issueNumber, [lgtmLabel])
}

async function bindsToCommit(octokit: Octokit, context: Context): Promise<boolean> {
  return lgtmSettings(await loadProwConfig(octokit, context)).bind_to_commit
}

async function cancelLgtm(
  octokit: Octokit,
  context: Context,
  issueNumber: number,
  commenterId: string,
  isPullRequest: boolean,
): Promise<void> {
  let currentLabels: string[]
  try {
    currentLabels = await getCurrentLabels(octokit, context, issueNumber)
  }
  catch (e) {
    throw new Error(`could not remove latest review: could not get labels from issue: ${e}`)
  }

  if (!currentLabels.includes(lgtmLabel)) {
    core.debug(`could not find ${lgtmLabel} to remove`)
    return
  }

  try {
    await removeLabels(octokit, context, issueNumber, [lgtmLabel])
  }
  catch (e) {
    throw new Error(`could not remove latest review: ${e}`)
  }

  if (isPullRequest && (await bindsToCommit(octokit, context))) {
    const { headSha } = await loadPullRequestOwners(octokit, context, issueNumber)
    await unbindLgtm(octokit, context, headSha, `lgtm cancelled by ${commenterId}`)
  }
}

async function assertReviewer(
  octokit: Octokit,
  context: Context,
  issueNumber: number,
  commenterId: string,
): Promise<void> {
  try {
    await assertAuthorizedByOwnersOrMembership(
      octokit,
      context,
      'reviewers',
      commenterId,
    )
  }
  catch (e) {
    await refuse(octokit, context, issueNumber, `Cannot apply the lgtm label because ${e}`, e)
  }
}

// refuse logs and replies with msg, then fails the run with cause (or msg)
async function refuse(
  octokit: Octokit,
  context: Context,
  issueNumber: number,
  msg: string,
  cause: unknown = new Error(msg),
): Promise<never> {
  core.error(msg)

  try {
    await createComment(octokit, context, issueNumber, msg)
  }
  catch (commentE) {
    core.error(`Could not comment with an auth error: ${commentE}`)
  }
  throw cause
}
