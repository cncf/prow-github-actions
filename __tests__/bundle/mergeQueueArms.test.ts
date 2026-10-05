import type { FakeGithub, MergeQueueFixture } from './fakeGithub'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import pullReqListPulls from '../fixtures/pullReq/pullReqListPulls.json'
import pullReqOpenedEvent from '../fixtures/pullReq/pullReqOpenedEvent.json'
import { start } from './fakeGithub'
import { configReads, helpersFor, ownersProbe, queueRead, repo, token } from './helpers'
import { runBundle } from './runBundle'

vi.setConfig({ testTimeout: 30_000 })

// the arms of tide's merge-queue path that bundle.test.ts does not reach — a pull request already in
// the queue, one the queue would refuse, a head that moves while mergeability is computed, each
// classified enqueue refusal, and a state query that answers without a pull request — driven through
// dist/index.js like the enqueue/dequeue happy paths in bundle.test.ts
describe('dist/index.js on a branch that requires a merge queue', () => {
  let gh: FakeGithub
  const { expectRequests } = helpersFor(() => gh)

  const pullRead = `GET ${repo}/pulls/1`
  const merge = `PUT ${repo}/pulls/1/merge`
  const head = pullReqOpenedEvent.pull_request.head.sha
  const bind = `POST ${repo}/statuses/${head}`
  const bindingRead = `GET ${repo}/commits/${head}/status?per_page=100`
  const bound = [{ context: 'prow/lgtm', state: 'success' }]
  const nodeId = 'PR_kwDOtest'

  beforeAll(async () => {
    gh = await start()
  })
  afterEach(() => gh.reset())
  afterAll(() => gh.close())

  function mergeablePr(state: string, sha = head) {
    const pr = structuredClone(pullReqListPulls[0])
    return { ...pr, number: 1, labels: [{ name: 'lgtm' }], mergeable: state === 'unknown' ? null : true, mergeable_state: state, head: { sha } }
  }

  function queue(overrides: Partial<MergeQueueFixture> = {}) {
    gh.mergeQueue({ pullRequestId: nodeId, headOid: head, enabled: true, ...overrides })
  }

  function labeledLgtm() {
    gh.commitStatuses(repo, head, bound)
    return runBundle({
      eventName: 'pull_request',
      payload: { ...pullReqOpenedEvent, action: 'labeled', label: { name: 'lgtm' } },
      inputs: { ...token, 'merge-method': 'squash' },
      apiUrl: gh.url,
    })
  }

  it('a pr already in the queue is skipped naming its position and state; nothing is enqueued', async () => {
    gh.route('GET', `${repo}/pulls/1`, { status: 200, body: mergeablePr('blocked') })
    queue({ inQueue: true, entry: { state: 'AWAITING_CHECKS', position: 2, enqueuer: 'alice' } })

    const result = await labeledLgtm()

    expect(result.status, result.stdout).toBe(0)
    expect(result.errors).toEqual([])
    expect(result.stdout).toContain('skipping pr #1: in the merge queue (position 2, AWAITING_CHECKS)')
    expect(gh.graphqlCalls('enqueuePullRequest')).toEqual([])
    expect(gh.requestsMatching('PUT', /./)).toEqual([])
    expectRequests(configReads(), [bind, pullRead, ownersProbe, bindingRead, queueRead])
  })

  it('a pr in the queue without an entry is skipped without a position', async () => {
    gh.route('GET', `${repo}/pulls/1`, { status: 200, body: mergeablePr('blocked') })
    queue({ inQueue: true })

    const result = await labeledLgtm()

    expect(result.status, result.stdout).toBe(0)
    expect(result.stdout).toContain('skipping pr #1: in the merge queue\n')
    expect(gh.graphqlCalls('enqueuePullRequest')).toEqual([])
    expectRequests(configReads(), [bind, pullRead, ownersProbe, bindingRead, queueRead])
  })

  it('a dirty pr is refused before the queue is asked: skipped, no enqueue', async () => {
    gh.route('GET', `${repo}/pulls/1`, { status: 200, body: mergeablePr('dirty') })
    queue()

    const result = await labeledLgtm()

    expect(result.status, result.stdout).toBe(0)
    expect(result.errors).toEqual([])
    expect(result.stdout).toContain('skipping pr #1: not mergeable (dirty)')
    expect(gh.graphqlCalls('enqueuePullRequest')).toEqual([])
    expectRequests(configReads(), [bind, pullRead, ownersProbe, bindingRead, queueRead])
  })

  it('a head that moves while mergeability is computed is skipped, not enqueued', async () => {
    gh.routeSequence('GET', `${repo}/pulls/1`, [
      { status: 200, body: mergeablePr('unknown') },
      { status: 200, body: mergeablePr('clean', 'movedsha') },
    ])
    queue()

    const result = await labeledLgtm()

    expect(result.status, result.stdout).toBe(0)
    expect(result.errors).toEqual([])
    expect(result.stdout).toContain('mergeability of pr #1 is not computed yet, retrying in 1000ms')
    expect(result.stdout).toContain('skipping pr #1: head moved during evaluation')
    expect(gh.graphqlCalls('enqueuePullRequest')).toEqual([])
    // the unknown first read is re-read once after the state query; the second answer settles it
    expectRequests(configReads(), [bind, pullRead, ownersProbe, bindingRead, queueRead, pullRead])
  })

  describe('an enqueue GitHub refuses', () => {
    it.each([
      ['Expected head oid to be abc but was def', 'skipping pr #1: head moved'],
      ['The pull request is already in the merge queue', 'skipping pr #1: already in the merge queue'],
      ['The pull request is not mergeable', 'skipping pr #1: not ready for the merge queue: The pull request is not mergeable'],
    ])('%s: skipped as %s, exit 0', async (message, logged) => {
      gh.route('GET', `${repo}/pulls/1`, { status: 200, body: mergeablePr('clean') })
      queue({ enqueueError: message })

      const result = await labeledLgtm()

      expect(result.status, result.stdout).toBe(0)
      expect(result.errors).toEqual([])
      expect(result.stdout).toContain(logged)
      expect(gh.graphqlCalls('enqueuePullRequest')).toHaveLength(1)
      expect(gh.requestsMatching('PUT', /./)).toEqual([])
      expectRequests(configReads(), [bind, pullRead, ownersProbe, bindingRead, queueRead, queueRead])
    })

    it('for a reason the bundle does not classify fails the run with GitHub\'s message', async () => {
      gh.route('GET', `${repo}/pulls/1`, { status: 200, body: mergeablePr('clean') })
      queue({ enqueueError: 'Something went wrong while enqueuing' })

      const result = await labeledLgtm()

      expect(result.status, result.stdout).toBe(1)
      expect(result.errors).toEqual([
        'could not enqueue pr #1: Something went wrong while enqueuing',
        'error handling pull_request event: could not merge pull request(s) #1',
      ])
      expect(gh.requestsMatching('PUT', /./)).toEqual([])
      expectRequests(configReads(), [bind, pullRead, ownersProbe, bindingRead, queueRead, queueRead])
    })

    it('with a non-GraphQL failure (an HTTP 500 on the mutation) fails the run with the transport message', async () => {
      gh.route('GET', `${repo}/pulls/1`, { status: 200, body: mergeablePr('clean') })
      gh.route('POST', '/graphql', (req) => {
        const query = String((req.body as { query?: string } | undefined)?.query ?? '')
        if (query.includes('enqueuePullRequest')) {
          return { status: 500, body: { message: 'Server Error' } }
        }
        return { status: 200, body: { data: { repository: { pullRequest: { id: nodeId, headRefOid: head, isMergeQueueEnabled: true, isInMergeQueue: false, mergeQueueEntry: null } } } } }
      })

      const result = await labeledLgtm()

      expect(result.status, result.stdout).toBe(1)
      // no GraphQL `errors` array to read: the transport's own message is reported
      expect(result.errors).toEqual([
        'could not enqueue pr #1: Server Error',
        'error handling pull_request event: could not merge pull request(s) #1',
      ])
      expect(gh.requestsMatching('PUT', /./)).toEqual([])
      expectRequests(configReads(), [bind, pullRead, ownersProbe, bindingRead, queueRead, queueRead])
    })
  })

  it('a state query that answers without a pull request falls back to the direct merge', async () => {
    gh.route('GET', `${repo}/pulls/1`, { status: 200, body: mergeablePr('clean') })
    gh.route('PUT', `${repo}/pulls/1/merge`, { status: 200, body: { merged: true } })
    gh.route('POST', '/graphql', { status: 200, body: { data: { repository: { pullRequest: null } } } })

    const result = await labeledLgtm()

    expect(result.status, result.stdout).toBe(0)
    expect(result.errors).toEqual([])
    expect(result.stdout).toContain('merged pr #1')
    expect(result.stdout).not.toContain('falling back to a direct merge')
    expectRequests(configReads(), [bind, pullRead, ownersProbe, bindingRead, queueRead, merge])
  })
})
