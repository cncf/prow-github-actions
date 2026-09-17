import type { Octokit } from '@octokit/rest'
import type { Context } from './context'

import * as core from '@actions/core'

export interface QueueEntry {
  state: string
  position: number
  enqueuer?: string
}

export interface QueueState {
  pullRequestId: string
  headOid: string
  enabled: boolean
  inQueue: boolean
  entry?: QueueEntry
}

export type EnqueueFailureKind = 'head_moved' | 'already_queued' | 'not_ready' | 'forbidden' | 'other'

export type EnqueueOutcome = { ok: true, position?: number } | { ok: false, message: string, kind: EnqueueFailureKind }

export const queueStateQuery = `query MergeQueueState($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      id
      headRefOid
      isMergeQueueEnabled
      isInMergeQueue
      mergeQueueEntry { state position enqueuer { login } }
    }
  }
}`

export const enqueueMutation = `mutation EnqueuePullRequest($pullRequestId: ID!, $expectedHeadOid: GitObjectID!) {
  enqueuePullRequest(input: { pullRequestId: $pullRequestId, expectedHeadOid: $expectedHeadOid }) {
    mergeQueueEntry { state position }
  }
}`

export const dequeueMutation = `mutation DequeuePullRequest($id: ID!) {
  dequeuePullRequest(input: { id: $id }) {
    mergeQueueEntry { state position }
  }
}`

interface QueueStateResponse {
  repository: {
    pullRequest: {
      id: string
      headRefOid: string
      isMergeQueueEnabled: boolean
      isInMergeQueue: boolean
      mergeQueueEntry: { state: string, position: number, enqueuer: { login: string } | null } | null
    } | null
  } | null
}

interface EnqueueResponse {
  enqueuePullRequest: { mergeQueueEntry: { state: string, position: number } | null } | null
}

let warnedUnavailable = false

export function resetMergeQueueWarnings(): void {
  warnedUnavailable = false
}

/**
 * queueState reads, in one GraphQL query, whether the pull request's base
 * branch requires a merge queue and whether the pull request is in it. Any
 * GraphQL failure (a GHES without the fields, a token that may not read the
 * queue) is a warning, once per run, and `undefined`: the caller falls back
 * to the REST merge so existing users are never broken.
 *
 * @param octokit - a hydrated github client
 * @param context - the github context of the current action event
 * @param number - the pull request number
 */
export async function queueState(octokit: Octokit, context: Context, number: number): Promise<QueueState | undefined> {
  let data: QueueStateResponse
  try {
    data = await octokit.graphql<QueueStateResponse>(queueStateQuery, { ...context.repo, number })
  }
  catch (e) {
    if (!warnedUnavailable) {
      warnedUnavailable = true
      core.warning(`could not read the merge queue state of pr #${number}; falling back to a direct merge: ${errorMessage(e)}`)
    }
    return undefined
  }

  const pr = data.repository?.pullRequest
  if (pr == null) {
    return undefined
  }

  const entry = pr.mergeQueueEntry
  return {
    pullRequestId: pr.id,
    headOid: pr.headRefOid,
    enabled: pr.isMergeQueueEnabled,
    inQueue: pr.isInMergeQueue,
    ...(entry === null ? {} : { entry: { state: entry.state, position: entry.position, ...(entry.enqueuer === null ? {} : { enqueuer: entry.enqueuer.login }) } }),
  }
}

/**
 * enqueue adds the pull request to its base branch's merge queue, pinned to
 * `expectedHeadOid`: GitHub refuses when the head moved since. A refusal is
 * returned classified by its message, never thrown.
 *
 * @param octokit - a hydrated github client
 * @param context - the github context of the current action event
 * @param state - the queue state read moments ago
 * @param expectedHeadOid - the head commit the enqueue must apply to
 */
export async function enqueue(octokit: Octokit, context: Context, state: QueueState, expectedHeadOid: string): Promise<EnqueueOutcome> {
  try {
    const data = await octokit.graphql<EnqueueResponse>(enqueueMutation, { pullRequestId: state.pullRequestId, expectedHeadOid })
    const position = data.enqueuePullRequest?.mergeQueueEntry?.position
    return position === undefined ? { ok: true } : { ok: true, position }
  }
  catch (e) {
    const message = errorMessage(e)
    return { ok: false, message, kind: classify(message) }
  }
}

/**
 * dequeue removes the pull request from the merge queue. The mutation takes
 * the pull request's node id, not the entry's. A refusal is a warning.
 *
 * @param octokit - a hydrated github client
 * @param context - the github context of the current action event
 * @param state - the queue state read moments ago
 * @param number - the pull request number, for the log
 */
export async function dequeue(octokit: Octokit, context: Context, state: QueueState, number: number): Promise<boolean> {
  try {
    await octokit.graphql(dequeueMutation, { id: state.pullRequestId })
    return true
  }
  catch (e) {
    core.warning(`could not dequeue pr #${number}: ${errorMessage(e)}`)
    return false
  }
}

const botLoginPattern = /^github-actions$|\[bot\]$/i

/**
 * enqueuedByBot reports whether the queue entry was made by an automation
 * (`github-actions` or any `[bot]`), which the gate may undo; a human who
 * enqueued deliberately is never fought.
 *
 * @param entry - the merge queue entry, if any
 */
export function enqueuedByBot(entry: QueueEntry | undefined): boolean {
  return entry?.enqueuer !== undefined && botLoginPattern.test(entry.enqueuer)
}

function classify(message: string): EnqueueFailureKind {
  const lower = message.toLowerCase()
  if (/expected head|head oid|head_oid/.test(lower)) {
    return 'head_moved'
  }
  if (lower.includes('already')) {
    return 'already_queued'
  }
  if (/not mergeable|required|checks|not ready/.test(lower)) {
    return 'not_ready'
  }
  if (/permission|resource not accessible|forbidden/.test(lower)) {
    return 'forbidden'
  }
  return 'other'
}

function errorMessage(e: unknown): string {
  if (typeof e === 'object' && e !== null && 'errors' in e && Array.isArray(e.errors)) {
    const messages = e.errors.map((error: { message?: string }) => error.message).filter((m): m is string => typeof m === 'string')
    if (messages.length > 0) {
      return messages.join('; ')
    }
  }
  return e instanceof Error ? e.message : String(e)
}
