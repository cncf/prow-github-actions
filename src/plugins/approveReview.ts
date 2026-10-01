import type { Octokit } from '@octokit/rest'
import type { Context } from '../utils/context'
import type { PullRequestOwners } from '../utils/pullRequestOwners'
import type { ApprovalEvent, ApprovalState, ApproveSettings, Review } from './approve'

import * as core from '@actions/core'

import { isBotUser } from '../utils/comments'

/** identifies the APPROVE review that mirrors the `approved` label (`approve.github_review`) */
export const reviewMarker = '<!-- prow-github-actions/approve-review -->'

/** who the workflow token acts as */
export interface TokenIdentity {
  /** the lowercased login behind a user token (PAT); undefined for an installation token (`GITHUB_TOKEN`, a GitHub App), whose reviews are authored by a `Bot` user */
  login?: string
}

// memoized per client: GET /user is read at most once per handler run
const identities = new WeakMap<Octokit, Promise<TokenIdentity>>()

/**
 * tokenIdentity asks GitHub who the token is (`GET /user`), once per client.
 * An installation token, `GITHUB_TOKEN` included, may not read `/user` and
 * is answered with 403 (404 on some servers): its reviews are authored by a
 * `Bot` user, which the approve plugin never counts anyway, so the login is
 * left undefined. Any other failure fails the evaluation.
 *
 * @param octokit - a hydrated github client
 */
export function tokenIdentity(octokit: Octokit): Promise<TokenIdentity> {
  let pending = identities.get(octokit)
  if (pending === undefined) {
    pending = octokit.users.getAuthenticated().then(
      ({ data }) => ({ login: data.login.toLowerCase() }),
      (e: unknown) => {
        const status = errorStatus(e)
        if (status === 403 || status === 404) {
          core.debug(`approve: GET /user answered ${status}; the token is an installation token`)
          return {}
        }
        throw new Error(`could not identify the token for approve.github_review: ${e}`)
      },
    )
    identities.set(octokit, pending)
  }
  return pending
}

/**
 * isOwnReview reports whether a review is the mirrored approval this action
 * submitted: it carries the marker and was written by the token's identity
 * (any `Bot` user when the token is an installation token).
 *
 * @param review - a review of the pull request
 * @param identity - who the token is
 */
export function isOwnReview(review: Review, identity: TokenIdentity): boolean {
  if (!(review.body ?? '').includes(reviewMarker)) {
    return false
  }
  const login = review.user?.login?.toLowerCase()
  return identity.login === undefined ? isBotUser(review.user) : login === identity.login
}

/**
 * reviewBody is the text of the mirrored approval: who approved, without
 * an `@`, since every push submits a fresh review and a mention would notify
 * the approvers each time.
 *
 * @param state - the computed approval
 */
export function reviewBody(state: ApprovalState): string {
  return [
    `Approved via /approve by ${[...state.approvers].join(', ')} (OWNERS).`,
    '',
    'This review mirrors the `approved` label: it is submitted while the label is set and dismissed when the label goes away. Use `/approve` and `/approve cancel` to change it.',
    reviewMarker,
  ].join('\n')
}

const reasonFiles = 5
const withdrawals: Partial<Record<ApprovalEvent['kind'], string>> = {
  'cancel': '/approve cancel',
  'review-changes': 'changes requested',
  'lgtm-cancel': '/lgtm cancel',
}

/**
 * withdrawalReason says why a pull request is not approved, for the
 * dismissal message: the files nobody covers and, when someone withdrew
 * their approval last, who and how.
 *
 * @param owners - the pull request and the OWNERS covering its files
 * @param state - the computed approval
 * @param events - what users did on the pull request, as counted
 * @param settings - the resolved `approve` configuration
 */
export function withdrawalReason(owners: PullRequestOwners, state: ApprovalState, events: ApprovalEvent[], settings: ApproveSettings): string {
  if (owners.files.length === 0) {
    return 'the pull request changes no files'
  }

  const shown = state.uncoveredFiles.slice(0, reasonFiles).join(', ')
  const more = state.uncoveredFiles.length > reasonFiles ? ` and ${state.uncoveredFiles.length - reasonFiles} more` : ''
  const reason = `no approver covers ${shown}${more}`

  const latest = new Map<string, ApprovalEvent>()
  for (const event of [...events].sort((a, b) => a.at.getTime() - b.at.getTime())) {
    if (event.kind.startsWith('lgtm') && !settings.lgtm_acts_as_approve) {
      continue
    }
    latest.set(event.user.toLowerCase(), event)
  }
  const withdrawn = [...latest.entries()]
    .filter(([, event]) => withdrawals[event.kind] !== undefined)
    .map(([user, event]) => `${user} (${withdrawals[event.kind]})`)
    .sort()

  return withdrawn.length === 0 ? reason : `${reason}; withdrawn by ${withdrawn.join(', ')}`
}

export interface MirrorInput {
  owners: PullRequestOwners
  state: ApprovalState
  /** every review of the pull request, bots included */
  reviews: Review[]
  identity: TokenIdentity
  /** why the pull request is not approved; only read when it is not */
  reason: () => string
}

export const notPermittedWarning = 'cannot submit the approval review: enable "Allow GitHub Actions to create and approve pull requests" (Settings → Actions → General) or pass a token that can (approve.github_review)'

/**
 * syncApprovalReview makes the action's own APPROVE review follow the
 * `approved` label (`approve.github_review`). Approved: one review by the
 * token on the current head commit, submitted unless it already exists.
 * Not approved: every such review the action submitted earlier is dismissed,
 * on any commit. Reviews without the marker, or by anyone else, are never
 * touched. GitHub refusing the approval itself (the repository does not let
 * Actions approve, or the token authored the pull request) is a warning;
 * any other API error fails the evaluation.
 *
 * @param octokit - a hydrated github client
 * @param context - the github context of the current action event
 * @param input - see MirrorInput
 */
export async function syncApprovalReview(octokit: Octokit, context: Context, input: MirrorInput): Promise<void> {
  const { owners, state, reviews, identity } = input
  const number = owners.number
  if (!owners.open) {
    core.debug(`approve: #${number} is not open; its approval review is left alone`)
    return
  }

  const own = reviews.filter(review => review.state === 'APPROVED' && isOwnReview(review, identity))

  if (!state.approved) {
    if (own.length === 0) {
      core.debug(`approve: #${number} carries no approval review to dismiss`)
      return
    }
    const message = `approved removed: ${input.reason()}`
    for (const review of own) {
      try {
        await octokit.pulls.dismissReview({ ...context.repo, pull_number: number, review_id: review.id, message })
      }
      catch (e) {
        throw new Error(`could not dismiss the approval review ${review.id}: ${e}`)
      }
      core.info(`approve: dismissed the approval review ${review.id} on #${number}: ${message}`)
    }
    return
  }

  if (own.some(review => review.commit_id === owners.headSha)) {
    core.debug(`approve: #${number} already carries the approval review on ${owners.headSha}`)
    return
  }
  if (identity.login !== undefined && identity.login === owners.author) {
    core.warning(selfApprovalWarning(number, identity.login))
    return
  }

  try {
    await octokit.pulls.createReview({
      ...context.repo,
      pull_number: number,
      commit_id: owners.headSha,
      event: 'APPROVE',
      body: reviewBody(state),
    })
  }
  catch (e) {
    const message = errorMessage(e)
    if (/approve your own pull request/i.test(message)) {
      core.warning(selfApprovalWarning(number, owners.author))
      return
    }
    if (errorStatus(e) === 403 || /not permitted to approve pull requests/i.test(message)) {
      core.warning(`${notPermittedWarning}: ${message}`)
      return
    }
    throw new Error(`could not submit the approval review: ${e}`)
  }
  core.info(`approve: submitted the approval review on #${number} at ${owners.headSha}`)
}

function selfApprovalWarning(number: number, login: string): string {
  return `cannot submit the approval review: #${number} was opened by the token's own identity (${login}), and GitHub does not let an author approve their own pull request (approve.github_review)`
}

function errorStatus(e: unknown): number | undefined {
  return typeof e === 'object' && e !== null && 'status' in e && typeof e.status === 'number' ? e.status : undefined
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
