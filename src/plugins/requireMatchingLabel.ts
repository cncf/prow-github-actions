import type { Octokit } from '@octokit/rest'
import type { ProwConfig, RequireMatchingLabel } from '../utils/config'
import type { Context } from '../utils/context'

import * as core from '@actions/core'
import * as github from '@actions/github'

import { createComment } from '../utils/comments'
import { loadProwConfig } from '../utils/config'
import { getCurrentLabels, labelIssue, removeLabels } from '../utils/labeling'
import { newOctokit } from '../utils/octokit'
import { sleep } from '../utils/sleep'

export type Verdict = 'add' | 'remove' | 'none'

const triggerActions = new Set(['opened', 'reopened', 'labeled', 'unlabeled'])
const graceActions = new Set(['opened', 'reopened'])

/** github actions minutes are billed, so a rule may not park the runner for longer */
export const maxGracePeriodMs = 30_000

const durationUnits: Record<string, number> = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 }
const durationPart = /(\d+(?:\.\d+)?)(ms|[smh])/gy

interface IssueComment {
  id: number
  body?: string | null
  user?: { login?: string, type?: string } | null
}

/**
 * parseDuration reads a Go style duration such as `5s`, `2m30s` or `500ms`
 * and returns milliseconds; an empty or `0` value is zero.
 *
 * @param text - the configured `grace_period_duration`
 */
export function parseDuration(text: string | undefined): number {
  const value = (text ?? '').trim()
  if (value === '' || value === '0') {
    return 0
  }

  let ms = 0
  let consumed = 0
  durationPart.lastIndex = 0
  for (let match = durationPart.exec(value); match !== null; match = durationPart.exec(value)) {
    ms += Number.parseFloat(match[1]) * durationUnits[match[2]]
    consumed = durationPart.lastIndex
  }

  if (consumed !== value.length) {
    throw new Error(`invalid grace_period_duration '${text}': expected a duration such as 5s, 2m or 500ms`)
  }

  return Math.round(ms)
}

/**
 * applicableRules narrows the configured rules to the ones that concern this
 * object and, on a `labeled`/`unlabeled` event, this label. Unlike Prow, a
 * change to the `missing_label` itself also re-evaluates the rule, so a
 * `needs-*` label removed by hand while nothing matches comes back.
 *
 * @param config - the merged prow configuration
 * @param isPullRequest - whether the object is a pull request
 * @param changedLabel - the label that was added or removed, if any
 */
export function applicableRules(config: ProwConfig, isPullRequest: boolean, changedLabel?: string): RequireMatchingLabel[] {
  return config.require_matching_label.filter((rule) => {
    if ((isPullRequest ? rule.prs : rule.issues) !== true) {
      return false
    }
    if (changedLabel === undefined) {
      return true
    }
    return new RegExp(rule.regexp).test(changedLabel) || sameLabel(rule.missing_label, changedLabel)
  })
}

/**
 * evaluate decides what a rule wants done given the labels on the object.
 *
 * @param rule - the rule to apply
 * @param labels - the labels currently on the issue or pull request
 */
export function evaluate(rule: RequireMatchingLabel, labels: string[]): Verdict {
  const pattern = new RegExp(rule.regexp)
  const hasMatch = labels.some(label => pattern.test(label))
  const hasMissing = labels.some(label => sameLabel(label, rule.missing_label))

  if (hasMatch && hasMissing) {
    return 'remove'
  }
  if (!hasMatch && !hasMissing) {
    return 'add'
  }
  return 'none'
}

/**
 * requireMatchingLabel is the `issues` / `pull_request` event handler: on
 * `opened`, `reopened`, `labeled` and `unlabeled` it applies every
 * configured `require_matching_label` rule that concerns the object.
 *
 * @param context - the github context of the current action event
 */
export async function requireMatchingLabel(context: Context = github.context): Promise<void> {
  const action: string | undefined = context.payload.action
  if (action === undefined || !triggerActions.has(action)) {
    core.debug(`require-matching-label: skipping ${action} action`)
    return
  }

  const changedLabel: string | undefined = action === 'labeled' || action === 'unlabeled'
    ? context.payload.label?.name
    : undefined

  await enforce(context, changedLabel, graceActions.has(action))
}

/**
 * checkRequiredLabels is the `/check-required-labels` comment command: it
 * re-evaluates every applicable rule on an open issue or pull request at once.
 *
 * @param context - the github context of the current action event
 */
export async function checkRequiredLabels(context: Context = github.context): Promise<void> {
  if (context.payload.issue?.state !== 'open') {
    core.debug('require-matching-label: the issue is not open, nothing to check')
    return
  }

  await enforce(context, undefined, false)
}

async function enforce(context: Context, changedLabel: string | undefined, withGracePeriod: boolean): Promise<void> {
  const token = core.getInput('github-token', { required: true })
  const octokit = newOctokit(token)

  const config = await loadProwConfig(octokit, context)
  if (config.require_matching_label.length === 0) {
    core.debug('require-matching-label: no rules configured')
    return
  }

  const { issueNumber, isPullRequest } = subject(context)
  const rules = applicableRules(config, isPullRequest, changedLabel)
  if (rules.length === 0) {
    core.debug(`require-matching-label: no rule applies to ${isPullRequest ? 'pull request' : 'issue'} #${issueNumber}${changedLabel === undefined ? '' : ` for label ${changedLabel}`}`)
    return
  }

  const graceMs = Math.min(maxGracePeriodMs, Math.max(0, ...rules.map(rule => parseDuration(rule.grace_period_duration))))
  if (withGracePeriod && graceMs > 0) {
    core.debug(`require-matching-label: waiting ${graceMs}ms for other labelers`)
    await sleep(graceMs)
  }

  const labels = await getCurrentLabels(octokit, context, issueNumber)

  const errors: string[] = []
  for (const rule of rules) {
    try {
      await apply(octokit, context, issueNumber, rule, labels)
    }
    catch (e) {
      errors.push(`${rule.missing_label}: ${e instanceof Error ? e.message : e}`)
    }
  }

  if (errors.length > 0) {
    throw new Error(`require-matching-label ${errors.join('; ')}`)
  }
}

function subject(context: Context): { issueNumber: number, isPullRequest: boolean } {
  const { payload } = context
  if (payload.pull_request !== undefined) {
    return { issueNumber: payload.pull_request.number, isPullRequest: true }
  }
  if (payload.issue !== undefined) {
    return { issueNumber: payload.issue.number, isPullRequest: payload.issue.pull_request !== undefined }
  }
  throw new Error(`github context payload missing issue or pull request: ${JSON.stringify(payload)}`)
}

async function apply(octokit: Octokit, context: Context, issueNumber: number, rule: RequireMatchingLabel, labels: string[]): Promise<void> {
  const verdict = evaluate(rule, labels)

  switch (verdict) {
    case 'add':
      await labelIssue(octokit, context, issueNumber, [rule.missing_label])
      if (rule.missing_comment !== undefined) {
        await postMissingComment(octokit, context, issueNumber, rule)
      }
      return

    case 'remove': {
      const present = labels.filter(label => sameLabel(label, rule.missing_label))
      await removeLabels(octokit, context, issueNumber, present)
      if (rule.missing_comment !== undefined) {
        await deleteMissingComments(octokit, context, issueNumber, rule)
      }
      return
    }

    default:
      core.debug(`require-matching-label: ${rule.missing_label} is already correct on #${issueNumber}`)
  }
}

// the marker is an invisible HTML comment that lets a later run find and delete the bot's own comment
function markerFor(rule: RequireMatchingLabel): string {
  return `<!-- prow-github-actions/require-matching-label: ${rule.missing_label} -->`
}

async function postMissingComment(octokit: Octokit, context: Context, issueNumber: number, rule: RequireMatchingLabel): Promise<void> {
  const existing = await botCommentsWithMarker(octokit, context, issueNumber, rule)
  if (existing.length > 0) {
    core.debug(`require-matching-label: ${rule.missing_label} comment already present on #${issueNumber}`)
    return
  }

  await createComment(octokit, context, issueNumber, `${rule.missing_comment}\n\n${markerFor(rule)}`)
}

async function deleteMissingComments(octokit: Octokit, context: Context, issueNumber: number, rule: RequireMatchingLabel): Promise<void> {
  for (const comment of await botCommentsWithMarker(octokit, context, issueNumber, rule)) {
    try {
      await octokit.issues.deleteComment({ ...context.repo, comment_id: comment.id })
    }
    catch (e) {
      throw new Error(`could not delete comment ${comment.id}: ${e}`)
    }
  }
}

async function botCommentsWithMarker(octokit: Octokit, context: Context, issueNumber: number, rule: RequireMatchingLabel): Promise<IssueComment[]> {
  const marker = markerFor(rule)
  let comments: IssueComment[]
  try {
    comments = await octokit.paginate(octokit.issues.listComments, { ...context.repo, issue_number: issueNumber, per_page: 100 })
  }
  catch (e) {
    throw new Error(`could not list comments: ${e}`)
  }

  return comments.filter(comment => isBot(comment) && (comment.body ?? '').includes(marker))
}

function isBot(comment: IssueComment): boolean {
  return comment.user?.type === 'Bot' || comment.user?.login === 'github-actions[bot]'
}

function sameLabel(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase()
}
