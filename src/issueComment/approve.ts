import type { Octokit } from '@octokit/rest'
import type { Review } from '../plugins/approve'
import type { Context } from '../utils/context'

import { platform } from '../platform'
import { approveSettings, evaluateApproval } from '../plugins/approve'
import { tokenLogin } from '../plugins/approveReview'
import { assertAuthorizedByOwnersOrMembership } from '../utils/auth'
import { hasCommand, hasExactArgs } from '../utils/command'
import { createComment, normalizeLogin } from '../utils/comments'
import { loadProwConfig } from '../utils/config'
import { newOctokitFromInputs } from '../utils/octokit'
import { loadPullRequestOwners } from '../utils/pullRequestOwners'

/**
 * /approve on a pull request whose base branch has OWNERS files records the
 * commenter's approval for the files they own and re-evaluates the approve
 * plugin's coverage, which manages the `approved` label and the notifier
 * comment; no GitHub review is submitted. /approve cancel withdraws it the
 * same way: the comment itself is the state, so both just recompute.
 *
 * On a pull request in a repository without OWNERS files the legacy
 * behaviour is kept: org members and collaborators make the token's identity
 * (github-actions[bot], a GitHub App's `<slug>[bot]`, or a PAT's user) submit
 * an APPROVE review, and /approve cancel or /remove-approve dismisses its
 * latest one. On an issue it only replies that it applies to pull requests.
 * The Prow argument 'no-issue' is accepted and ignored.
 *
 * @param context - the github actions event context
 */
export async function approve(
  context: Context = platform().context(),
): Promise<void> {
  platform().log.debug(`starting approve job`)
  const octokit = newOctokitFromInputs()

  const issueNumber: number | undefined = context.payload.issue?.number
  const commentBody: string = context.payload.comment?.body
  const commenterLogin: string = context.payload.comment?.user.login

  if (issueNumber === undefined) {
    throw new Error(
      `github context payload missing issue number: ${JSON.stringify(context.payload)}`,
    )
  }

  const isCancel = hasCommand('/remove-approve', commentBody)
    || hasExactArgs('/approve', commentBody, 'cancel')

  if (context.payload.issue?.pull_request === undefined) {
    await createComment(octokit, context, issueNumber, '`/approve` only applies to pull requests.')
    return
  }

  const owners = await loadPullRequestOwners(octokit, context, issueNumber)
  if (owners.tree.hasOwners) {
    await approveByCoverage(octokit, context, issueNumber, commenterLogin, isCancel)
    return
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
    platform().log.debug(`creating a review`)
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
  platform().log.error(msg)

  try {
    await createComment(octokit, context, issueNumber, msg)
  }
  catch (commentE) {
    platform().log.error(`Could not comment with an auth error: ${commentE}`)
  }
  throw cause
}

/**
 * Removes the latest APPROVE review the token's identity submitted
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
  platform().log.debug(`canceling latest review`)

  let reviews: Review[]
  try {
    reviews = await octokit.paginate(octokit.pulls.listReviews, { ...context.repo, pull_number: issueNumber, per_page: 100 })
  }
  catch (e) {
    throw new Error(`could not list reviews for PR ${issueNumber}: ${e}`)
  }

  // the token's own reviews: a GitHub App's are authored by `<slug>[bot]`, GITHUB_TOKEN's by github-actions[bot]
  const self = await tokenLogin(octokit) ?? 'github-actions'
  let latestReview

  for (const e of reviews) {
    platform().log.debug(`checking review: ${e.user?.login}`)
    if (e.user?.login !== undefined && normalizeLogin(e.user.login) === self && e.state === 'APPROVED') {
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
