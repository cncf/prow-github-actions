import type { Octokit } from '@octokit/rest'
import type { ProwConfig } from '../utils/config'
import type { Context } from '../utils/context'
import type { PullRequestOwners } from '../utils/pullRequestOwners'

import * as core from '@actions/core'
import * as github from '@actions/github'

import { getCommandArgs, hasCommand, hasKeyword } from '../utils/command'
import { createComment } from '../utils/comments'
import { loadProwConfig } from '../utils/config'
import { labelIssue, removeLabels } from '../utils/labeling'
import { newOctokit } from '../utils/octokit'
import { repoHasOwners } from '../utils/owners'
import { loadPullRequestOwners } from '../utils/pullRequestOwners'

export interface ApproveSettings {
  require_self_approval: boolean
  ignore_review_state: boolean
  lgtm_acts_as_approve: boolean
}

export type ApprovalEventKind = 'approve' | 'cancel' | 'review-approved' | 'review-changes' | 'lgtm' | 'lgtm-cancel'

export interface ApprovalEvent {
  user: string
  kind: ApprovalEventKind
  at: Date
}

export interface ApprovalState {
  /** the current approvers who cover at least one changed file, the implicit author included */
  approvers: Set<string>
  /** changed file to the approvers covering it, sorted */
  coveredFiles: Map<string, string[]>
  uncoveredFiles: string[]
  /** who to ask so that every uncovered file gets an approver, fewest people first */
  suggested: string[]
  approved: boolean
}

export interface IssueComment {
  id: number
  body?: string | null
  user?: { login?: string, type?: string } | null
  created_at: string
}

export interface Review {
  id: number
  state: string
  user?: { login?: string, type?: string } | null
  submitted_at?: string | null
}

export const approvedLabel = 'approved'
export const notifierMarker = '<!-- prow-github-actions/approve -->'
const commandsDoc = 'https://github.com/cncf/prow-github-actions/blob/main/docs/commands.md'

const pullRequestActions = new Set(['opened', 'reopened', 'synchronize', 'labeled', 'unlabeled'])
const reviewActions = new Set(['submitted', 'dismissed'])

/**
 * approveSettings resolves the `approve` configuration with Prow's defaults:
 * the author approves implicitly, reviews count, `/lgtm` does not.
 *
 * @param config - the merged prow configuration
 */
export function approveSettings(config: ProwConfig): ApproveSettings {
  const raw = config.approve
  return {
    require_self_approval: raw.require_self_approval ?? false,
    ignore_review_state: raw.ignore_review_state ?? false,
    lgtm_acts_as_approve: raw.lgtm_acts_as_approve ?? false,
  }
}

/**
 * approvalEvents reads the `/approve`, `/approve cancel`, `/lgtm` family of
 * comments and the APPROVED / CHANGES_REQUESTED reviews of humans into events,
 * logins lowercased. Bots, other review states and comments without a command
 * yield nothing; a comment carrying both a command and its cancel is a cancel.
 *
 * @param comments - the issue comments of the pull request
 * @param reviews - the reviews of the pull request
 */
export function approvalEvents(comments: IssueComment[], reviews: Review[]): ApprovalEvent[] {
  const events: ApprovalEvent[] = []

  for (const comment of comments) {
    const login = humanLogin(comment.user)
    const body = comment.body ?? ''
    if (login === undefined || body === '') {
      continue
    }
    const at = new Date(comment.created_at)
    const approveKind = commandKind(body, '/approve', '/remove-approve')
    if (approveKind !== undefined) {
      events.push({ user: login, kind: approveKind === 'cancel' ? 'cancel' : 'approve', at })
    }
    const lgtmKind = commandKind(body, '/lgtm', '/remove-lgtm')
    if (lgtmKind !== undefined) {
      events.push({ user: login, kind: lgtmKind === 'cancel' ? 'lgtm-cancel' : 'lgtm', at })
    }
  }

  for (const review of reviews) {
    const login = humanLogin(review.user)
    if (login === undefined || review.submitted_at == null) {
      continue
    }
    const at = new Date(review.submitted_at)
    if (review.state === 'APPROVED') {
      events.push({ user: login, kind: 'review-approved', at })
    }
    else if (review.state === 'CHANGES_REQUESTED') {
      events.push({ user: login, kind: 'review-changes', at })
    }
  }

  return events
}

function commandKind(body: string, command: string, removeAlias: string): 'add' | 'cancel' | undefined {
  if (hasCommand(removeAlias, body)) {
    return 'cancel'
  }
  if (!hasCommand(command, body)) {
    return undefined
  }
  return hasKeyword(getCommandArgs(command, body), 'cancel') ? 'cancel' : 'add'
}

function humanLogin(user: IssueComment['user']): string | undefined {
  if (user?.login === undefined || user.login === '' || user.type === 'Bot' || user.login === 'github-actions[bot]') {
    return undefined
  }
  return user.login.toLowerCase()
}

/**
 * computeApproval decides, like Prow's approve plugin, whether the current
 * approvers collectively cover every changed file. It is recomputed from
 * scratch on every evaluation: the events are the only input and the
 * `approved` label is the only thing persisted, so no hidden state can drift.
 *
 * @param owners - the pull request and the OWNERS covering its files
 * @param events - what users did on the pull request, in any order
 * @param settings - the resolved `approve` configuration
 */
export function computeApproval(owners: PullRequestOwners, events: ApprovalEvent[], settings: ApproveSettings): ApprovalState {
  const author = owners.author
  const approving = new Set<string>()
  if (!settings.require_self_approval && author !== '') {
    approving.add(author)
  }

  // each user's latest action wins; a cancel or a CHANGES_REQUESTED review after an approval removes it
  const ordered = [...events].sort((a, b) => a.at.getTime() - b.at.getTime())
  for (const event of ordered) {
    const user = event.user.toLowerCase()
    if (settings.require_self_approval && user === author) {
      continue
    }
    switch (effectiveKind(event.kind, settings)) {
      case 'add':
        approving.add(user)
        break
      case 'remove':
        approving.delete(user)
        break
      default:
        break
    }
  }

  const coveredFiles = new Map<string, string[]>()
  const uncoveredFiles: string[] = []
  const covering = new Set<string>()
  for (const file of owners.files) {
    const set = owners.perFile.get(file)
    const approvers = set === undefined ? [] : [...approving].filter(login => set.approvers.has(login)).sort()
    if (approvers.length > 0) {
      coveredFiles.set(file, approvers)
      approvers.forEach(login => covering.add(login))
    }
    else {
      uncoveredFiles.push(file)
    }
  }

  for (const login of approving) {
    if (!covering.has(login)) {
      core.debug(`approve: ${login} approves none of the changed files of #${owners.number}; ignored`)
    }
  }

  const excluded = new Set(covering)
  if (settings.require_self_approval && author !== '') {
    excluded.add(author)
  }

  return {
    approvers: new Set([...covering].sort()),
    coveredFiles,
    uncoveredFiles,
    suggested: suggestApprovers(owners, uncoveredFiles, excluded),
    approved: owners.files.length > 0 && uncoveredFiles.length === 0,
  }
}

function effectiveKind(kind: ApprovalEventKind, settings: ApproveSettings): 'add' | 'remove' | 'ignore' {
  switch (kind) {
    case 'approve':
      return 'add'
    case 'cancel':
      return 'remove'
    case 'review-approved':
      return settings.ignore_review_state ? 'ignore' : 'add'
    case 'review-changes':
      return settings.ignore_review_state ? 'ignore' : 'remove'
    case 'lgtm':
      return settings.lgtm_acts_as_approve ? 'add' : 'ignore'
    case 'lgtm-cancel':
      return settings.lgtm_acts_as_approve ? 'remove' : 'ignore'
    default:
      return 'ignore'
  }
}

// greedy set cover: repeatedly take the approver who covers the most still-uncovered files, ties alphabetically
function suggestApprovers(owners: PullRequestOwners, uncovered: string[], excluded: Set<string>): string[] {
  const remaining = new Set(uncovered)
  const suggested: string[] = []

  while (remaining.size > 0) {
    const coverage = new Map<string, number>()
    for (const file of remaining) {
      for (const login of owners.perFile.get(file)?.approvers ?? []) {
        if (!excluded.has(login)) {
          coverage.set(login, (coverage.get(login) ?? 0) + 1)
        }
      }
    }
    if (coverage.size === 0) {
      break
    }

    const [best] = [...coverage.entries()].sort(([a, countA], [b, countB]) => countB - countA || a.localeCompare(b))[0]
    suggested.push(best)
    excluded.add(best)
    for (const file of remaining) {
      if (owners.perFile.get(file)?.approvers.has(best)) {
        remaining.delete(file)
      }
    }
  }

  return suggested
}

/**
 * renderNotifier writes Prow's `[APPROVALNOTIFIER]` comment: the verdict,
 * the approvers so far, who to assign next, and every OWNERS file the pull
 * request touches, struck through once an approver covers it.
 *
 * @param state - the computed approval
 * @param owners - the pull request and the OWNERS covering its files
 * @param repo - the repository, for the OWNERS file links
 * @param repo.owner - the repository owner
 * @param repo.repo - the repository name
 */
export function renderNotifier(state: ApprovalState, owners: PullRequestOwners, repo: { owner: string, repo: string }): string {
  const approvers = [...state.approvers].map(login => `*${login}*`).join(', ')
  const lines = [
    `[APPROVALNOTIFIER] This PR is **${state.approved ? 'APPROVED' : 'NOT APPROVED'}**`,
    '',
  ]

  if (owners.files.length === 0) {
    lines.push('This pull request changes no files, so there is nothing to approve.', notifierMarker)
    return lines.join('\n')
  }

  lines.push(`This pull-request has been approved by:${approvers === '' ? '' : ` ${approvers}`}`)
  if (state.approved) {
    lines.push('', `The full list of commands accepted by this bot can be found [here](${commandsDoc}).`)
  }
  else if (state.suggested.length > 0) {
    lines.push(
      `To complete the pull request process, please assign ${state.suggested.map(login => `**${login}**`).join(', ')} after the PR has been reviewed.`,
      `You can assign the PR to them by writing \`/assign ${state.suggested.map(login => `@${login}`).join(' ')}\` in a comment when ready.`,
    )
  }

  lines.push('', '<details><summary>Needs approval from an approver in each of these files:</summary>', '')
  for (const entry of ownersEntries(state, owners)) {
    if (entry.path === undefined) {
      lines.push(`- **${entry.file}** (no OWNERS file covers this file)`)
      continue
    }
    const link = `[${entry.path}](https://github.com/${repo.owner}/${repo.repo}/blob/${owners.baseSha}/${entry.path})`
    lines.push(entry.approvers.length > 0 ? `- ~~${link}~~ [${entry.approvers.join(', ')}]` : `- **${link}**`)
  }
  lines.push(
    '',
    'Approvers can indicate their approval by writing `/approve` in a comment',
    'Approvers can cancel approval by writing `/approve cancel` in a comment',
    '</details>',
    notifierMarker,
  )

  return lines.join('\n')
}

interface OwnersEntry {
  /** the deepest OWNERS file covering the group, undefined when none does */
  path?: string
  file: string
  approvers: string[]
}

// one line per deepest OWNERS file: every file it covers shares the same effective approvers
function ownersEntries(state: ApprovalState, owners: PullRequestOwners): OwnersEntry[] {
  const byPath = new Map<string, OwnersEntry>()
  const uncoverable: OwnersEntry[] = []
  for (const file of owners.files) {
    const set = owners.perFile.get(file)
    if (set === undefined) {
      uncoverable.push({ file, approvers: [] })
      continue
    }
    const path = set.sources[0]
    const approvers = state.coveredFiles.get(file) ?? []
    const entry = byPath.get(path)
    if (entry === undefined) {
      byPath.set(path, { path, file, approvers })
    }
    else {
      entry.approvers = [...new Set([...entry.approvers, ...approvers])].sort()
    }
  }
  return [
    ...[...byPath.values()].sort((a, b) => a.path!.localeCompare(b.path!)),
    ...uncoverable.sort((a, b) => a.file.localeCompare(b.file)),
  ]
}

/**
 * evaluateApproval recomputes the approval of a pull request from its
 * comments and reviews, then makes the `approved` label and the notifier
 * comment match: the label is added or removed only when it changes, the
 * notifier is posted once and edited in place afterwards. A pull request
 * whose base branch has no OWNERS files is left alone.
 *
 * @param octokit - a hydrated github client
 * @param context - the github context of the current action event
 * @param pullNumber - the pull request
 */
export async function evaluateApproval(octokit: Octokit, context: Context, pullNumber: number): Promise<void> {
  const owners = await loadPullRequestOwners(octokit, context, pullNumber)
  if (!owners.tree.hasOwners) {
    core.debug(`approve: the base of #${pullNumber} has no OWNERS files, nothing to evaluate`)
    return
  }

  const settings = approveSettings(await loadProwConfig(octokit, context))
  const comments = await listComments(octokit, context, pullNumber)
  const reviews = settings.ignore_review_state ? [] : await listReviews(octokit, context, pullNumber)
  const state = computeApproval(owners, approvalEvents(comments, reviews), settings)

  core.info(state.approved
    ? `approve: #${pullNumber} is approved by ${[...state.approvers].join(', ')}`
    : `approve: #${pullNumber} is not approved; nobody approves ${state.uncoveredFiles.join(', ') || 'anything'}`)

  await syncLabel(octokit, context, owners, state.approved)
  await upsertNotifier(octokit, context, pullNumber, comments, renderNotifier(state, owners, context.repo))
}

async function syncLabel(octokit: Octokit, context: Context, owners: PullRequestOwners, approved: boolean): Promise<void> {
  const present = owners.labels.filter(label => label.toLowerCase() === approvedLabel)
  if (approved && present.length === 0) {
    await labelIssue(octokit, context, owners.number, [approvedLabel])
  }
  else if (!approved && present.length > 0) {
    await removeLabels(octokit, context, owners.number, present)
  }
  else {
    core.debug(`approve: the ${approvedLabel} label on #${owners.number} is already correct`)
  }
}

async function upsertNotifier(octokit: Octokit, context: Context, pullNumber: number, comments: IssueComment[], body: string): Promise<void> {
  const existing = comments.find(comment => isBot(comment.user) && (comment.body ?? '').includes(notifierMarker))
  if (existing === undefined) {
    await createComment(octokit, context, pullNumber, body)
    return
  }

  if ((existing.body ?? '').trim() === body.trim()) {
    core.debug(`approve: the notifier on #${pullNumber} is up to date`)
    return
  }

  try {
    await octokit.issues.updateComment({ ...context.repo, comment_id: existing.id, body })
  }
  catch (e) {
    throw new Error(`could not update the approval notifier: ${e}`)
  }
}

function isBot(user: IssueComment['user']): boolean {
  return user?.type === 'Bot' || user?.login === 'github-actions[bot]'
}

async function listComments(octokit: Octokit, context: Context, pullNumber: number): Promise<IssueComment[]> {
  try {
    return await octokit.paginate(octokit.issues.listComments, { ...context.repo, issue_number: pullNumber, per_page: 100 })
  }
  catch (e) {
    throw new Error(`could not list comments: ${e}`)
  }
}

async function listReviews(octokit: Octokit, context: Context, pullNumber: number): Promise<Review[]> {
  try {
    return await octokit.paginate(octokit.pulls.listReviews, { ...context.repo, pull_number: pullNumber, per_page: 100 })
  }
  catch (e) {
    throw new Error(`could not list reviews: ${e}`)
  }
}

/**
 * approveOnPullRequest is the `pull_request` handler: on `opened`,
 * `reopened` and `synchronize`, and when a human adds or removes the
 * `approved` label, it re-evaluates the approval. Approval is sticky across
 * pushes; a push only matters because the changed files may differ.
 *
 * @param context - the github context of the current action event
 */
export async function approveOnPullRequest(context: Context = github.context): Promise<void> {
  const action: string | undefined = context.payload.action
  if (action === undefined || !pullRequestActions.has(action)) {
    core.debug(`approve: skipping ${action} action`)
    return
  }
  if ((action === 'labeled' || action === 'unlabeled') && String(context.payload.label?.name ?? '').toLowerCase() !== approvedLabel) {
    core.debug(`approve: ${action} ${context.payload.label?.name} does not concern approval`)
    return
  }

  await evaluateOnOwnersRepo(context, context.payload.pull_request?.number)
}

/**
 * approveOnReview is the `pull_request_review` handler: a submitted or
 * dismissed review may add (APPROVED) or remove (CHANGES_REQUESTED) an approver.
 *
 * @param context - the github context of the current action event
 */
export async function approveOnReview(context: Context = github.context): Promise<void> {
  const action: string | undefined = context.payload.action
  if (action === undefined || !reviewActions.has(action)) {
    core.debug(`approve: skipping ${action} review action`)
    return
  }

  await evaluateOnOwnersRepo(context, context.payload.pull_request?.number)
}

async function evaluateOnOwnersRepo(context: Context, pullNumber: number | undefined): Promise<void> {
  if (pullNumber === undefined) {
    throw new Error(`github context payload missing pull request: ${JSON.stringify(context.payload)}`)
  }

  const octokit = newOctokit(core.getInput('github-token', { required: true }))
  if (!(await repoHasOwners(octokit, context))) {
    core.debug('approve: the repository has no OWNERS files')
    return
  }

  await evaluateApproval(octokit, context, pullNumber)
}
