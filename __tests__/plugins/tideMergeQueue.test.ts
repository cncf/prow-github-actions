import * as core from '@actions/core'
import { http } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { evaluateMerge, tideOnPullRequest } from '../../src/plugins/tide'
import { resolveTide } from '../../src/utils/config'
import { newOctokit } from '../../src/utils/octokit'
import * as sleepModule from '../../src/utils/sleep'
import pullReqOpenedEvent from '../fixtures/pullReq/pullReqOpenedEvent.json'
import * as utils from '../testUtils'

const server = setupServer()
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

const repo = `${utils.api}/repos/Codertocat/Hello-World`
const tide = resolveTide({ merge_method: 'squash' })
const nodeId = 'PR_kwDOtest'

function pull(labels: string[], overrides: Record<string, unknown> = {}) {
  return {
    number: 1,
    state: 'open',
    locked: false,
    draft: false,
    merged: false,
    mergeable: true,
    mergeable_state: 'clean',
    labels: labels.map(name => ({ name })),
    head: { sha: 'headsha' },
    ...overrides,
  }
}

function servePull(...bodies: Record<string, unknown>[]) {
  const gets: string[] = []
  server.use(
    http.get(`${repo}/pulls/1`, () => {
      const body = bodies[Math.min(gets.length, bodies.length - 1)]
      gets.push('get')
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }),
  )
  return gets
}

function observeMerge(status = 200, body: unknown = { merged: true }) {
  const observe = new utils.ObserveRequest()
  server.use(http.put(`${repo}/pulls/1/merge`, utils.mockResponse(status, body, observe)))
  return observe
}

function serveGraphql(queue: utils.MergeQueueFixture = {}) {
  const { handler, calls } = utils.mergeQueueGraphql(queue)
  server.use(handler)
  return calls
}

const mutations = utils.graphqlMutations

let octokit: ReturnType<typeof newOctokit>
let context: utils.MockContext

beforeEach(() => {
  utils.setupActionsEnv()
  server.use(utils.lgtmStatus())
  vi.spyOn(sleepModule, 'sleep').mockResolvedValue(undefined)
  octokit = newOctokit('some-token')
  context = new utils.MockContext(pullReqOpenedEvent)
  context.eventName = 'pull_request'
})

describe('evaluateMerge on a branch that requires a merge queue', () => {
  it('headline: a clean pr passing the gate is enqueued with expectedHeadOid = the bound head, and never PUT-merged', async () => {
    const gets = servePull(pull(['lgtm']))
    const merge = observeMerge()
    const calls = serveGraphql({ enabled: true })
    const info = vi.spyOn(core, 'info')

    await expect(evaluateMerge(octokit, context, 1, tide)).resolves.toEqual({ result: 'enqueued', position: 3 })
    await expect(merge.notCalled()).resolves.toBe('not called')
    expect(gets).toHaveLength(1)
    expect(calls).toHaveLength(2)
    expect(calls[0].query).toContain('isMergeQueueEnabled')
    expect(calls[0].variables).toEqual({ owner: 'Codertocat', repo: 'Hello-World', number: 1 })
    const enqueue = mutations(calls, 'enqueuePullRequest')
    expect(enqueue).toHaveLength(1)
    expect(enqueue[0].variables).toEqual({ pullRequestId: nodeId, expectedHeadOid: 'headsha' })
    expect(info).toHaveBeenCalledWith('enqueued pr #1 (position 3)')
  })

  it('a blocked pr is still enqueued: required checks are the queue\'s business', async () => {
    servePull(pull(['lgtm'], { mergeable_state: 'blocked' }))
    const merge = observeMerge()
    const calls = serveGraphql()
    const debug = vi.spyOn(core, 'debug')

    await expect(evaluateMerge(octokit, context, 1, tide)).resolves.toMatchObject({ result: 'enqueued' })
    await expect(merge.notCalled()).resolves.toBe('not called')
    expect(mutations(calls, 'enqueuePullRequest')).toHaveLength(1)
    expect(debug).toHaveBeenCalledWith('pr #1: mergeable_state is blocked; left to the merge queue')
  })

  it.each(['behind', 'unstable'])('a %s pr is enqueued too', async (state) => {
    servePull(pull(['lgtm'], { mergeable_state: state }))
    observeMerge()
    const calls = serveGraphql()

    await expect(evaluateMerge(octokit, context, 1, tide)).resolves.toMatchObject({ result: 'enqueued' })
    expect(mutations(calls, 'enqueuePullRequest')).toHaveLength(1)
  })

  it('a dirty pr (conflicts) is skipped without a mutation', async () => {
    servePull(pull(['lgtm'], { mergeable_state: 'dirty', mergeable: false }))
    const merge = observeMerge()
    const calls = serveGraphql()
    const info = vi.spyOn(core, 'info')

    await expect(evaluateMerge(octokit, context, 1, tide)).resolves.toEqual({ result: 'skipped', reason: 'not mergeable (dirty)' })
    await expect(merge.notCalled()).resolves.toBe('not called')
    expect(mutations(calls, 'enqueuePullRequest')).toHaveLength(0)
    expect(info).toHaveBeenCalledWith('skipping pr #1: not mergeable (dirty)')
  })

  it('a draft pr is skipped without a mutation (the gate fails, so only the dequeue check runs)', async () => {
    servePull(pull(['lgtm'], { draft: true, mergeable_state: 'draft' }))
    const calls = serveGraphql()

    await expect(evaluateMerge(octokit, context, 1, tide)).resolves.toEqual({ result: 'skipped', reason: 'not mergeable (draft)' })
    expect(calls).toHaveLength(1)
    expect(mutations(calls, 'enqueuePullRequest')).toHaveLength(0)
  })

  it('an unknown state is retried, then enqueued', async () => {
    const gets = servePull(pull(['lgtm'], { mergeable: null, mergeable_state: 'unknown' }), pull(['lgtm']))
    const calls = serveGraphql()

    await expect(evaluateMerge(octokit, context, 1, tide)).resolves.toMatchObject({ result: 'enqueued' })
    expect(gets).toHaveLength(2)
    expect(mutations(calls, 'enqueuePullRequest')).toHaveLength(1)
  })

  it('a pr already in the queue is skipped with its position and state, no mutation', async () => {
    servePull(pull(['lgtm']))
    const merge = observeMerge()
    const calls = serveGraphql({ inQueue: true, entry: { state: 'AWAITING_CHECKS', position: 2, enqueuer: 'alice' } })
    const info = vi.spyOn(core, 'info')

    await expect(evaluateMerge(octokit, context, 1, tide)).resolves.toEqual({ result: 'skipped', reason: 'in the merge queue (position 2, AWAITING_CHECKS)' })
    await expect(merge.notCalled()).resolves.toBe('not called')
    expect(calls).toHaveLength(1)
    expect(info).toHaveBeenCalledWith('skipping pr #1: in the merge queue (position 2, AWAITING_CHECKS)')
  })

  it.each([
    ['The expected head OID does not match the head of the pull request', 'head moved'],
    ['Pull request is already in the merge queue', 'already in the merge queue'],
  ])('an enqueue refused with "%s" is skipped as "%s"', async (message, reason) => {
    servePull(pull(['lgtm']))
    serveGraphql({ enqueueError: message })
    const error = vi.spyOn(core, 'error').mockImplementation(() => {})

    await expect(evaluateMerge(octokit, context, 1, tide)).resolves.toEqual({ result: 'skipped', reason })
    expect(error).not.toHaveBeenCalled()
  })

  it('an enqueue refused because required checks have not passed is skipped as not ready, with GitHub\'s message', async () => {
    servePull(pull(['lgtm']))
    serveGraphql({ enqueueError: 'Pull request is not mergeable: required status checks have not passed' })

    await expect(evaluateMerge(octokit, context, 1, tide)).resolves.toEqual({
      result: 'skipped',
      reason: 'not ready for the merge queue: Pull request is not mergeable: required status checks have not passed',
    })
  })

  it('an enqueue refused for lack of permission fails with the grant hint', async () => {
    servePull(pull(['lgtm']))
    serveGraphql({ enqueueError: 'Resource not accessible by integration' })
    const error = vi.spyOn(core, 'error').mockImplementation(() => {})

    const verdict = await evaluateMerge(octokit, context, 1, tide)
    expect(verdict.result).toBe('failed')
    expect(verdict).toMatchObject({ message: expect.stringContaining('cannot add pr #1 to the merge queue: the token may not enqueue (grant contents: write and pull-requests: write') })
    expect(verdict).toMatchObject({ message: expect.stringContaining('automatic-merging.md#merge-queues') })
    expect(error).toHaveBeenCalledOnce()
  })

  it('any other enqueue error fails with the raw message', async () => {
    servePull(pull(['lgtm']))
    serveGraphql({ enqueueError: 'Something went wrong' })
    vi.spyOn(core, 'error').mockImplementation(() => {})

    await expect(evaluateMerge(octokit, context, 1, tide)).resolves.toEqual({ result: 'failed', message: expect.stringContaining('Something went wrong') })
  })

  it('a GraphQL error on the state query is a warning and falls back to the REST merge', async () => {
    servePull(pull(['lgtm']))
    const merge = observeMerge()
    const calls = serveGraphql({ queryError: 'Field \'isMergeQueueEnabled\' doesn\'t exist on type \'PullRequest\'' })
    const warning = vi.spyOn(core, 'warning').mockImplementation(() => {})

    await expect(evaluateMerge(octokit, context, 1, tide)).resolves.toEqual({ result: 'merged' })
    await expect(merge.called()).resolves.toBe('called')
    expect(await merge.body()).toEqual({ merge_method: 'squash', sha: 'headsha' })
    expect(mutations(calls, 'enqueuePullRequest')).toHaveLength(0)
    expect(warning).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('could not read the merge queue state'))
  })

  it('the fallback warning is logged once per run', async () => {
    servePull(pull(['lgtm']))
    observeMerge()
    serveGraphql({ queryError: 'boom' })
    const warning = vi.spyOn(core, 'warning').mockImplementation(() => {})

    await evaluateMerge(octokit, context, 1, tide)
    await evaluateMerge(octokit, context, 1, tide)
    expect(warning).toHaveBeenCalledTimes(1)
  })

  it('no queue on the base branch: the REST path, exactly as before', async () => {
    const gets = servePull(pull(['lgtm']))
    const merge = observeMerge()
    const calls = serveGraphql({ enabled: false })

    await expect(evaluateMerge(octokit, context, 1, tide)).resolves.toEqual({ result: 'merged' })
    await expect(merge.called()).resolves.toBe('called')
    expect(gets).toHaveLength(1)
    expect(calls).toHaveLength(1)
  })

  it('no queue: a blocked pr is still skipped by mergeable_state', async () => {
    servePull(pull(['lgtm'], { mergeable_state: 'blocked' }))
    const merge = observeMerge()
    serveGraphql({ enabled: false })

    await expect(evaluateMerge(octokit, context, 1, tide)).resolves.toEqual({ result: 'skipped', reason: 'not mergeable (blocked)' })
    await expect(merge.notCalled()).resolves.toBe('not called')
  })

  it('merge_queue: off never calls GraphQL and the REST 405 surfaces as today', async () => {
    servePull(pull(['lgtm']))
    const merge = observeMerge(405, { message: 'Changes must be made through the merge queue.' })
    vi.spyOn(core, 'error').mockImplementation(() => {})
    // no /graphql handler: an unhandled request would fail the test

    await expect(evaluateMerge(octokit, context, 1, resolveTide({ merge_queue: 'off' }))).resolves.toEqual({
      result: 'failed',
      message: expect.stringContaining('Changes must be made through the merge queue.'),
      status: 405,
    })
    await expect(merge.called()).resolves.toBe('called')
  })

  it('debugs once that the queue\'s merge method wins over tide.merge_method', async () => {
    servePull(pull(['lgtm']))
    serveGraphql()
    const debug = vi.spyOn(core, 'debug')

    await evaluateMerge(octokit, context, 1, tide)
    await evaluateMerge(octokit, context, 1, tide)
    expect(debug.mock.calls.filter(call => String(call[0]).includes('merge_method squash is ignored'))).toHaveLength(1)
  })

  it('the gate is checked before the queue: a pr without lgtm makes no GraphQL call', async () => {
    servePull(pull(['kind/bug']))
    const calls = serveGraphql()
    const c = new utils.MockContext(pullReqOpenedEvent)
    c.eventName = 'schedule'

    await expect(evaluateMerge(octokit, c, 1, tide)).resolves.toEqual({ result: 'skipped', reason: 'missing lgtm' })
    expect(calls).toHaveLength(0)
  })
})

describe('dequeue when the gate breaks', () => {
  it('unlabeled lgtm on an in-queue pr the bot enqueued: dequeued with the pr node id', async () => {
    servePull(pull([]))
    const calls = serveGraphql({ inQueue: true, entry: { state: 'QUEUED', position: 1, enqueuer: 'github-actions' } })
    const info = vi.spyOn(core, 'info')

    await expect(evaluateMerge(octokit, context, 1, tide)).resolves.toEqual({ result: 'skipped', reason: 'missing lgtm (dequeued)' })
    const dequeue = mutations(calls, 'dequeuePullRequest')
    expect(dequeue).toHaveLength(1)
    expect(dequeue[0].variables).toEqual({ id: nodeId })
    expect(info).toHaveBeenCalledWith('dequeued pr #1: missing lgtm')
  })

  it('a [bot] enqueuer counts as the bot too', async () => {
    servePull(pull(['lgtm', 'do-not-merge/hold']))
    const calls = serveGraphql({ inQueue: true, entry: { state: 'QUEUED', position: 1, enqueuer: 'my-app[bot]' } })

    await expect(evaluateMerge(octokit, context, 1, tide)).resolves.toEqual({ result: 'skipped', reason: 'blocked by do-not-merge/hold (dequeued)' })
    expect(mutations(calls, 'dequeuePullRequest')).toHaveLength(1)
  })

  it('a human enqueued it: left alone', async () => {
    servePull(pull([]))
    const calls = serveGraphql({ inQueue: true, entry: { state: 'QUEUED', position: 1, enqueuer: 'alice' } })
    const debug = vi.spyOn(core, 'debug')

    await expect(evaluateMerge(octokit, context, 1, tide)).resolves.toEqual({ result: 'skipped', reason: 'missing lgtm' })
    expect(mutations(calls, 'dequeuePullRequest')).toHaveLength(0)
    expect(debug).toHaveBeenCalledWith('pr #1 was enqueued by alice; leaving it in the queue')
  })

  it('not in the queue: one query, no mutation', async () => {
    servePull(pull([]))
    const calls = serveGraphql({ inQueue: false })

    await expect(evaluateMerge(octokit, context, 1, tide)).resolves.toEqual({ result: 'skipped', reason: 'missing lgtm' })
    expect(calls).toHaveLength(1)
  })

  it('on schedule the gate failing makes no GraphQL call at all', async () => {
    servePull(pull([]))
    const calls = serveGraphql({ inQueue: true })
    const c = new utils.MockContext(pullReqOpenedEvent)
    c.eventName = 'schedule'

    await expect(evaluateMerge(octokit, c, 1, tide)).resolves.toEqual({ result: 'skipped', reason: 'missing lgtm' })
    expect(calls).toHaveLength(0)
  })

  it('merge_queue: off: no GraphQL call when the gate fails', async () => {
    servePull(pull([]))

    await expect(evaluateMerge(octokit, context, 1, resolveTide({ merge_queue: 'off' }))).resolves.toEqual({ result: 'skipped', reason: 'missing lgtm' })
  })

  it('a stale lgtm on an in-queue bot-enqueued pr is stripped and dequeued', async () => {
    const sha = 'def0123456789abcdef0123456789abcdef01234'
    servePull(pull(['lgtm'], { head: { sha } }))
    server.use(
      utils.lgtmStatus(sha, false),
      http.delete(`${repo}/issues/1/labels/lgtm`, utils.mockResponse(200, [])),
      http.post(`${repo}/statuses/${sha}`, utils.mockResponse(201, {})),
      http.get(`${repo}/issues/1/comments`, utils.mockResponse(200, [])),
      http.post(`${repo}/issues/1/comments`, utils.mockResponse(201, {})),
    )
    const calls = serveGraphql({ inQueue: true, headOid: sha })

    await expect(evaluateMerge(octokit, context, 1, tide)).resolves.toEqual({ result: 'skipped', reason: 'lgtm not bound to def0123 (dequeued)' })
    expect(mutations(calls, 'dequeuePullRequest')).toHaveLength(1)
  })

  it('a refused dequeue is a warning, not a failure', async () => {
    servePull(pull([]))
    serveGraphql({ inQueue: true, dequeueError: 'Resource not accessible by integration' })
    const warning = vi.spyOn(core, 'warning').mockImplementation(() => {})

    await expect(evaluateMerge(octokit, context, 1, tide)).resolves.toEqual({ result: 'skipped', reason: 'missing lgtm' })
    expect(warning).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('could not dequeue pr #1'))
  })

  it('a failed state query on the gate-failing path is a warning; the skip stands', async () => {
    servePull(pull([]))
    serveGraphql({ queryError: 'boom' })
    const warning = vi.spyOn(core, 'warning').mockImplementation(() => {})

    await expect(evaluateMerge(octokit, context, 1, tide)).resolves.toEqual({ result: 'skipped', reason: 'missing lgtm' })
    expect(warning).toHaveBeenCalledOnce()
  })
})

describe('tideOnPullRequest with a merge queue', () => {
  beforeEach(() => {
    server.use(...utils.noOrgOrRepoConfigExcept(), utils.defaultBranchTree())
  })

  it('labeled lgtm on a queue-enabled pr: enqueued, the run succeeds', async () => {
    servePull(pull(['lgtm']))
    const merge = observeMerge()
    const calls = serveGraphql()
    const c = new utils.MockContext({ ...pullReqOpenedEvent, action: 'labeled', label: { name: 'lgtm' } })
    c.eventName = 'pull_request'

    await expect(tideOnPullRequest(c)).resolves.toBeUndefined()
    await expect(merge.notCalled()).resolves.toBe('not called')
    expect(mutations(calls, 'enqueuePullRequest')).toHaveLength(1)
  })

  it('a forbidden enqueue fails the run', async () => {
    servePull(pull(['lgtm']))
    serveGraphql({ enqueueError: 'Resource not accessible by integration' })
    vi.spyOn(core, 'error').mockImplementation(() => {})
    const c = new utils.MockContext({ ...pullReqOpenedEvent, action: 'labeled', label: { name: 'lgtm' } })
    c.eventName = 'pull_request'

    await expect(tideOnPullRequest(c)).rejects.toThrow('could not merge pull request(s) #1')
  })
})
