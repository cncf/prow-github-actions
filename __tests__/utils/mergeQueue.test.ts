import * as core from '@actions/core'
import { Octokit } from '@octokit/rest'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import {
  dequeue,
  dequeueMutation,
  enqueue,
  enqueuedByBot,
  enqueueMutation,
  queueState,
  queueStateQuery,
  resetMergeQueueWarnings,
} from '../../src/utils/mergeQueue'
import pullReqOpenedEvent from '../fixtures/pullReq/pullReqOpenedEvent.json'

import * as utils from '../testUtils'

const server = setupServer()
beforeAll(() => {
  utils.setupActionsEnv()
  server.listen({ onUnhandledRequest: 'error' })
})
beforeEach(() => resetMergeQueueWarnings())
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

const octokit = new Octokit({ auth: 'some-token' })
const context = new utils.MockContext(pullReqOpenedEvent)
const state = { pullRequestId: 'PR_kwDOtest', headOid: 'headsha', enabled: true, inQueue: false }

/** answers every GraphQL request with `data` (or a GraphQL error), recording the calls */
function graphql(data: unknown, error?: string) {
  const calls: utils.GraphqlCall[] = []
  server.use(http.post(`${utils.api}/graphql`, async ({ request }) => {
    calls.push(await request.json() as utils.GraphqlCall)
    return HttpResponse.json(error === undefined ? { data } : { data: null, errors: [{ message: error }] })
  }))
  return calls
}

describe('queueState', () => {
  it('reads the queue state and maps the entry with its enqueuer', async () => {
    const calls = graphql({ repository: { pullRequest: {
      id: 'PR_1',
      headRefOid: 'abc123',
      isMergeQueueEnabled: true,
      isInMergeQueue: true,
      mergeQueueEntry: { state: 'QUEUED', position: 2, enqueuer: { login: 'alice' } },
    } } })

    await expect(queueState(octokit, context, 7)).resolves.toEqual({
      pullRequestId: 'PR_1',
      headOid: 'abc123',
      enabled: true,
      inQueue: true,
      entry: { state: 'QUEUED', position: 2, enqueuer: 'alice' },
    })
    expect(calls).toHaveLength(1)
    expect(calls[0].query).toBe(queueStateQuery)
    expect(calls[0].variables).toEqual({ ...context.repo, number: 7 })
  })

  it('omits the enqueuer when GitHub reports none', async () => {
    graphql({ repository: { pullRequest: {
      id: 'PR_1',
      headRefOid: 'abc123',
      isMergeQueueEnabled: true,
      isInMergeQueue: true,
      mergeQueueEntry: { state: 'AWAITING_CHECKS', position: 1, enqueuer: null },
    } } })

    const result = await queueState(octokit, context, 7)
    expect(result?.entry).toEqual({ state: 'AWAITING_CHECKS', position: 1 })
    expect(result?.entry).not.toHaveProperty('enqueuer')
  })

  it('omits the entry when the pull request is not queued', async () => {
    graphql({ repository: { pullRequest: {
      id: 'PR_1',
      headRefOid: 'abc123',
      isMergeQueueEnabled: false,
      isInMergeQueue: false,
      mergeQueueEntry: null,
    } } })

    const result = await queueState(octokit, context, 7)
    expect(result).toEqual({ pullRequestId: 'PR_1', headOid: 'abc123', enabled: false, inQueue: false })
    expect(result).not.toHaveProperty('entry')
  })

  it('is undefined when the repository has no such pull request', async () => {
    graphql({ repository: { pullRequest: null } })

    await expect(queueState(octokit, context, 7)).resolves.toBeUndefined()
    expect(core.warning).not.toHaveBeenCalled()
  })

  it('is undefined when the repository itself is missing from the response', async () => {
    graphql({ repository: null })

    await expect(queueState(octokit, context, 7)).resolves.toBeUndefined()
    expect(core.warning).not.toHaveBeenCalled()
  })

  it('warns once per run when the query fails, then stays quiet', async () => {
    graphql(null, 'Field isMergeQueueEnabled doesn\'t exist on type PullRequest')

    await expect(queueState(octokit, context, 7)).resolves.toBeUndefined()
    await expect(queueState(octokit, context, 8)).resolves.toBeUndefined()

    expect(core.warning).toHaveBeenCalledTimes(1)
    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining('could not read the merge queue state of pr #7; falling back to a direct merge: Field isMergeQueueEnabled doesn\'t exist on type PullRequest'))
  })

  it('warns again after the warning state is reset', async () => {
    graphql(null, 'boom')

    await queueState(octokit, context, 7)
    resetMergeQueueWarnings()
    await queueState(octokit, context, 7)

    expect(core.warning).toHaveBeenCalledTimes(2)
  })

  it('reports a transport failure by its message when the response carries no GraphQL errors', async () => {
    server.use(http.post(`${utils.api}/graphql`, () => HttpResponse.json({ message: 'Bad credentials' }, { status: 401 })))

    await expect(queueState(octokit, context, 7)).resolves.toBeUndefined()
    expect(core.warning).toHaveBeenCalledTimes(1)
    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining('Bad credentials'))
  })
})

describe('enqueue', () => {
  it('returns the queue position on success', async () => {
    const calls = graphql({ enqueuePullRequest: { mergeQueueEntry: { state: 'QUEUED', position: 3 } } })

    await expect(enqueue(octokit, context, state, 'headsha')).resolves.toEqual({ ok: true, position: 3 })
    expect(calls[0].query).toBe(enqueueMutation)
    expect(calls[0].variables).toEqual({ pullRequestId: 'PR_kwDOtest', expectedHeadOid: 'headsha' })
  })

  it('succeeds without a position when the mutation returns no entry', async () => {
    graphql({ enqueuePullRequest: { mergeQueueEntry: null } })

    const outcome = await enqueue(octokit, context, state, 'headsha')
    expect(outcome).toEqual({ ok: true })
    expect(outcome).not.toHaveProperty('position')
  })

  it('succeeds without a position when the mutation payload is null', async () => {
    graphql({ enqueuePullRequest: null })

    await expect(enqueue(octokit, context, state, 'headsha')).resolves.toEqual({ ok: true })
  })

  it.each([
    ['The expected head OID does not match', 'head_moved'],
    ['expectedHeadOid mismatch: head_oid changed', 'head_moved'],
    ['Pull request is already in the merge queue', 'already_queued'],
    ['Pull request is not mergeable', 'not_ready'],
    ['Required status checks have not passed', 'not_ready'],
    ['Pull request is not ready to be enqueued', 'not_ready'],
    ['Resource not accessible by integration', 'forbidden'],
    ['You do not have permission to enqueue', 'forbidden'],
    ['Something unexpected', 'other'],
  ])('classifies "%s" as %s', async (message, kind) => {
    graphql(null, message)

    await expect(enqueue(octokit, context, state, 'headsha')).resolves.toEqual({ ok: false, message, kind })
  })

  it('joins several GraphQL errors into one message', async () => {
    server.use(http.post(`${utils.api}/graphql`, () => HttpResponse.json({
      data: null,
      errors: [{ message: 'first' }, { type: 'NOT_FOUND' }, { message: 'second' }],
    })))

    await expect(enqueue(octokit, context, state, 'headsha')).resolves.toEqual({ ok: false, message: 'first; second', kind: 'other' })
  })

  it('falls back to the thrown error\'s message when no GraphQL error carries one', async () => {
    server.use(http.post(`${utils.api}/graphql`, () => HttpResponse.json({ data: null, errors: [{ type: 'NOT_FOUND' }] })))

    const outcome = await enqueue(octokit, context, state, 'headsha')
    expect(outcome.ok).toBe(false)
    expect(outcome).toMatchObject({ kind: 'other', message: expect.stringContaining('Request failed due to following response errors') })
  })

  it('never throws on a transport failure', async () => {
    server.use(http.post(`${utils.api}/graphql`, () => HttpResponse.json({ message: 'Resource not accessible by integration' }, { status: 403 })))

    const outcome = await enqueue(octokit, context, state, 'headsha')
    expect(outcome.ok).toBe(false)
    expect(outcome).toMatchObject({ kind: 'forbidden' })
  })
})

describe('dequeue', () => {
  it('is true when the mutation succeeds', async () => {
    const calls = graphql({ dequeuePullRequest: { mergeQueueEntry: { state: 'QUEUED', position: 1 } } })

    await expect(dequeue(octokit, context, state, 7)).resolves.toBe(true)
    expect(calls[0].query).toBe(dequeueMutation)
    expect(calls[0].variables).toEqual({ id: 'PR_kwDOtest' })
    expect(core.warning).not.toHaveBeenCalled()
  })

  it('is false and warns when the mutation is refused', async () => {
    graphql(null, 'Pull request is not in the merge queue')

    await expect(dequeue(octokit, context, state, 7)).resolves.toBe(false)
    expect(core.warning).toHaveBeenCalledWith('could not dequeue pr #7: Pull request is not in the merge queue')
  })
})

describe('enqueuedByBot', () => {
  it.each([
    ['github-actions', true],
    ['GitHub-Actions', true],
    ['dependabot[bot]', true],
    ['renovate[BOT]', true],
    ['alice', false],
    ['github-actions-fan', false],
    ['bot', false],
  ])('%s -> %s', (login, expected) => {
    expect(enqueuedByBot({ state: 'QUEUED', position: 1, enqueuer: login })).toBe(expected)
  })

  it('is false without an entry or an enqueuer', () => {
    expect(enqueuedByBot(undefined)).toBe(false)
    expect(enqueuedByBot({ state: 'QUEUED', position: 1 })).toBe(false)
  })
})
