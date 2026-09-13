import type { Octokit, RestEndpointMethodTypes } from '@octokit/rest'
import type { Context } from '../utils/context'

import * as core from '@actions/core'
import * as github from '@actions/github'
import { approveSettings, evaluateApproval } from '../plugins/approve'
import { assertAuthorizedByOwnersOrMembership } from '../utils/auth'
import { getCommandArgs, hasCommand, hasKeyword } from '../utils/command'
import { createComment } from '../utils/comments'
import { loadProwConfig } from '../utils/config'
import { newOctokit } from '../utils/octokit'
import { loadPullRequestOwners } from '../utils/pullRequestOwners'

type PullsListReviewsResponseType
  = RestEndpointMethodTypes['pulls']['listReviews']['response']

/**
 * /approve on a pull request whose base branch has OWNERS files records the
 * commenter's approval for the files they own and re-evaluates the approve
 * plugin's coverage, which manages the `approved` label and the notifier
 * comment; no GitHub review is submitted. /approve cancel withdraws it the
 * same way: the comment itself is the state, so both just recompute.
 *
 * Anywhere else (an issue, or a repository without OWNERS files) the legacy
 * behaviour is kept: org members and collaborators (or the root OWNERS
 * approvers on an issue) make the github-actions bot submit an APPROVE
 * review, and /approve cancel or /remove-approve dismisses its latest one.
 * The Prow argument 'no-issue' is accepted and ignored.
 *
 * @param context - the github actions event context
 */
export async function approve(
  context: Context = github.context,
): Promise<void> {
  core.debug(`starting approve job`)
  const token = core.getInput('github-token', { required: true })
  const octokit = newOctokit(token)

  const issueNumber: number | undefined = context.payload.issue?.number
  const commentBody: string = context.payload.comment?.body
  const commenterLogin: string = context.payload.comment?.user.login

  if (issueNumber === undefined) {
    throw new Error(
      `github context payload missing issue number: ${context.payload}`,
    )
  }

  const isCancel = hasCommand('/remove-approve', commentBody)
    || (hasCommand('/approve', commentBody) && hasKeyword(getCommandArgs('/approve', commentBody), 'cancel'))

  if (context.payload.issue?.pull_request !== undefined) {
    const owners = await loadPullRequestOwners(octokit, context, issueNumber)
    if (owners.tree.hasOwners) {
      await approveByCoverage(octokit, context, issueNumber, commenterLogin, isCancel)
      return
    }
  }

  await authorize(octokit, context, issueNumber, commenterLogin)

  if (isCancel) {
    try {
      await cancel(octokit, context, issueNumber, commenterLogin)
    }
    catch (e) {
      throw new Error(`could not remove latest review: ${e}`)
    }
    return
  }

  try {
    core.debug(`creating a review`)
    await octokit.pulls.createReview({
      ...context.repo,
      pull_number: issueNumber,
      event: 'APPROVE',
      comments: [],
    })
  }
  catch (e) {
    throw new Error(`could not create review: ${e}`)
  }
}

async function approveByCoverage(
  octokit: Octokit,
  context: Context,
  issueNumber: number,
  commenterLogin: string,
  isCancel: boolean,
): Promise<void> {
  const settings = approveSettings(await loadProwConfig(octokit, context))
  const isAuthor = commenterLogin.toLowerCase() === String(context.payload.issue?.user?.login ?? '').toLowerCase()
  if (settings.require_self_approval && isAuthor && !isCancel) {
    await refuse(octokit, context, issueNumber, 'Cannot approve the pull request: you cannot approve your own PR (approve.require_self_approval is set).')
  }

  await authorize(octokit, context, issueNumber, commenterLogin)
  await evaluateApproval(octokit, context, issueNumber)
}

async function authorize(octokit: Octokit, context: Context, issueNumber: number, commenterLogin: string): Promise<void> {
  try {
    await assertAuthorizedByOwnersOrMembership(
      octokit,
      context,
      'approvers',
      commenterLogin,
    )
  }
  catch (e) {
    await refuse(octokit, context, issueNumber, `Cannot approve the pull request: ${e}`, e)
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

/**
 * Removes the latest review from the github actions bot
 *
 * @param octokit - a hydrated github api client
 * @param context - the github actions workflow event context
 * @param issueNumber - the PR to remove the review
 * @param commenterLogin - the login name of the user who made comment
 */
async function cancel(
  octokit: Octokit,
  context: Context,
  issueNumber: number,
  commenterLogin: string,
): Promise<void> {
  core.debug(`canceling latest review`)

  let reviews: PullsListReviewsResponseType
  try {
    reviews = await octokit.pulls.listReviews({
      ...context.repo,
      pull_number: issueNumber,
    })
  }
  catch (e) {
    throw new Error(`could not list reviews for PR ${issueNumber}: ${e}`)
  }

  let latestReview

  for (const e of reviews.data) {
    core.debug(`checking review: ${e.user?.login}`)
    if (e.user?.login === 'github-actions[bot]' && e.state === 'APPROVED') {
      latestReview = e
    }
  }

  if (latestReview === undefined) {
    throw new Error('no latest review found to cancel')
  }

  try {
    await octokit.pulls.dismissReview({
      ...context.repo,
      pull_number: issueNumber,
      review_id: latestReview.id,
      message: `Canceled through prow-github-actions by @${commenterLogin}`,
    })
  }
  catch (e) {
    throw new Error(`could not dismiss review: ${e}`)
  }
}
