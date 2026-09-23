import type { Octokit } from '@octokit/rest'
import type { ProwConfig } from '../utils/config'
import type { Context } from '../utils/context'

import * as core from '@actions/core'
import * as github from '@actions/github'

import { createCommentOnce, isBotUser } from '../utils/comments'
import { loadProwConfig } from '../utils/config'
import { removeLabels } from '../utils/labeling'
import { newOctokit } from '../utils/octokit'

export interface LgtmSettings {
  bind_to_commit: boolean
}

export const lgtmLabel = 'lgtm'
/** the commit status context that records which head commit `/lgtm` reviewed */
export const lgtmStatusContext = 'prow/lgtm'
export const defaultLgtmSettings: LgtmSettings = { bind_to_commit: true }

export const permissionHint = 'grant `statuses: write` to the workflow (or set `lgtm.bind_to_commit: false`)'

/**
 * lgtmSettings resolves the `lgtm` configuration: binding on by default.
 *
 * @param config - the merged prow configuration
 */
export function lgtmSettings(config: ProwConfig): LgtmSettings {
  return { bind_to_commit: config.lgtm.bind_to_commit ?? true }
}

export function shortSha(sha: string): string {
  return sha.slice(0, 7)
}

export function hasLgtmLabel(labels: string[]): boolean {
  return labels.some(label => label.toLowerCase() === lgtmLabel)
}

function staleMarker(sha: string): string {
  return `<!-- prow-github-actions/lgtm-stale: ${shortSha(sha)} -->`
}

/**
 * bindLgtm records `sha` as the commit the lgtm reviewed: a `prow/lgtm`
 * commit status in state `success`. A status is the binding of choice
 * because only a write-token holder can set one (a pull request author
 * cannot forge it) and because it is per commit by construction: a new head
 * simply has none. A 403 is reported with the permission to grant.
 *
 * @param octokit - a hydrated github client
 * @param context - the github actions event context
 * @param sha - the head commit of the pull request
 * @param by - the login who said lgtm
 * @param targetUrl - the comment or pull request to link the status to
 */
export async function bindLgtm(octokit: Octokit, context: Context, sha: string, by: string, targetUrl?: string): Promise<void> {
  try {
    await octokit.repos.createCommitStatus({
      ...context.repo,
      sha,
      context: lgtmStatusContext,
      state: 'success',
      description: `lgtm by ${by} at ${shortSha(sha)}`.slice(0, 140),
      ...(targetUrl === undefined ? {} : { target_url: targetUrl }),
    })
  }
  catch (e) {
    if (isForbidden(e)) {
      throw new Error(`cannot bind lgtm to the commit: ${permissionHint}`)
    }
    throw new Error(`could not bind lgtm to ${shortSha(sha)}: ${e}`)
  }
}

/**
 * unbindLgtm sets the head's `prow/lgtm` status to `pending` so the checks
 * UI stops showing a green "lgtm by ..." once the label is gone. A refused
 * write is a warning: the label, not the status, is the gate.
 *
 * @param octokit - a hydrated github client
 * @param context - the github actions event context
 * @param sha - the head commit of the pull request
 * @param description - why the binding is void, ex: `lgtm cancelled by alice`
 */
export async function unbindLgtm(octokit: Octokit, context: Context, sha: string, description: string): Promise<void> {
  try {
    await octokit.repos.createCommitStatus({
      ...context.repo,
      sha,
      context: lgtmStatusContext,
      state: 'pending',
      description: description.slice(0, 140),
    })
  }
  catch (e) {
    core.warning(`could not set the ${lgtmStatusContext} status of ${shortSha(sha)} to pending: ${e}`)
  }
}

/**
 * isLgtmBound reports whether `sha` carries a `prow/lgtm` status in state
 * `success`. The combined status answers with the latest status per context,
 * so a later `pending` (cancel, stale) wins over an earlier `success`.
 *
 * @param octokit - a hydrated github client
 * @param context - the github actions event context
 * @param sha - the head commit of the pull request
 */
export async function isLgtmBound(octokit: Octokit, context: Context, sha: string): Promise<boolean> {
  let statuses: { context: string, state: string }[]
  try {
    statuses = (await octokit.repos.getCombinedStatusForRef({ ...context.repo, ref: sha, per_page: 100 })).data.statuses
  }
  catch (e) {
    const hint = isForbidden(e) ? `${permissionHint}: ` : ''
    throw new Error(`could not read the ${lgtmStatusContext} status of ${shortSha(sha)}: ${hint}${e}`)
  }

  return statuses.find(status => status.context === lgtmStatusContext)?.state === 'success'
}

/**
 * stripStaleLgtm removes an `lgtm` label that is not bound to the pull
 * request's head: the label goes (a refused removal throws), the head's
 * status is set to `pending`, and one comment per head explains why.
 *
 * @param octokit - a hydrated github client
 * @param context - the github actions event context
 * @param number - the pull request number
 * @param sha - the head commit the label is not bound to
 */
export async function stripStaleLgtm(octokit: Octokit, context: Context, number: number, sha: string): Promise<void> {
  const short = shortSha(sha)
  await removeLabels(octokit, context, number, [lgtmLabel])
  await unbindLgtm(octokit, context, sha, `lgtm removed: not bound to ${short}`)

  try {
    await createCommentOnce(octokit, context, number, staleMarker(sha), `\`lgtm\` is not bound to the current head commit (\`${short}\`): either commits were pushed after it was applied, or it was applied by hand where the bot could not record the commit. Removed. Re-apply with \`/lgtm\` once the current commits are reviewed.`)
  }
  catch (e) {
    core.warning(`could not comment on pr #${number} about the stale lgtm: ${e}`)
  }
}

/**
 * lgtmOnPullRequest is the `pull_request` / `pull_request_target` handler
 * for a hand-applied `lgtm`: on `labeled` by a human it binds the label to
 * the payload's head commit. The bot's own label writes fire no event, and
 * `unlabeled` needs nothing: the label is the gate, the status the binding.
 *
 * @param context - the github context of the current action event
 */
export async function lgtmOnPullRequest(context: Context = github.context): Promise<void> {
  if (context.payload.action !== 'labeled' || String(context.payload.label?.name ?? '').toLowerCase() !== lgtmLabel) {
    return
  }

  const sender = context.payload.sender
  if (isBotUser(sender)) {
    core.debug(`lgtm: labeled by ${sender?.login}, a bot; nothing to bind`)
    return
  }

  const sha: unknown = context.payload.pull_request?.head?.sha
  if (typeof sha !== 'string') {
    throw new TypeError(`github context payload missing pull request head: ${JSON.stringify(context.payload)}`)
  }

  const octokit = newOctokit(core.getInput('github-token', { required: true }))
  if (!lgtmSettings(await loadProwConfig(octokit, context)).bind_to_commit) {
    core.debug('lgtm: bind_to_commit is false')
    return
  }

  await bindLgtm(octokit, context, sha, String(sender?.login ?? 'unknown'), context.payload.pull_request?.html_url)
  core.info(`lgtm: bound the hand-applied label on #${context.payload.pull_request?.number} to ${shortSha(sha)}`)
}

function isForbidden(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'status' in error && error.status === 403
}
