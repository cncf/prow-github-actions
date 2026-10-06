import type { FakeGithub } from './fakeGithub'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import checkSuiteCompletedEvent from '../fixtures/pullReq/checkSuiteCompletedEvent.json'
import pullReqListPulls from '../fixtures/pullReq/pullReqListPulls.json'
import { prCommentEvent } from '../utils/ownersFixtures'
import { start } from './fakeGithub'
import { configReads, helpersFor, ownersProbe, queueRead, repo, token } from './helpers'
import { runBundle } from './runBundle'

vi.setConfig({ testTimeout: 30_000 })

// the verdicts of tide's evaluateMerge that bundle.test.ts and mergeQueueArms.test.ts never reach — a pull
// request GitHub reports as merged, closed or locked, a mergeability that stays `unknown` through every
// retry, a head that moves while it is computed, a merge refused because a sibling event landed first or
// because the base moved under it, and a refused merge whose re-read fails too — plus tideOnComment's
// closed pull request and tideOnCheckSuite's missing-sha and nothing-to-evaluate arms, all driven through
// dist/index.js. `check_suite` is the vehicle: tide is its only handler, so the recorded traffic is tide's
describe('dist/index.js tide verdicts', () => {
  let gh: FakeGithub
  const { expectRequests } = helpersFor(() => gh)

  const pullRead = `GET ${repo}/pulls/1`
  const merge = `PUT ${repo}/pulls/1/merge`
  const head = checkSuiteCompletedEvent.check_suite.head_sha
  const bindingRead = `GET ${repo}/commits/${head}/status?per_page=100`
  const bound = [{ context: 'prow/lgtm', state: 'success' }]

  beforeAll(async () => {
    gh = await start()
  })
  beforeEach(() => gh.mergeQueueFallback({ pullRequestId: 'PR_none', headOid: head, enabled: false }))
  afterEach(() => gh.reset())
  afterAll(() => gh.close())

  function pr(state: string, overrides: Record<string, unknown> = {}) {
    const base = structuredClone(pullReqListPulls[0])
    return {
      ...base,
      number: 1,
      labels: [{ name: 'lgtm' }],
      mergeable: state === 'unknown' ? null : true,
      mergeable_state: state,
      head: { sha: head },
      ...overrides,
    }
  }

  function checkSuite(pullRequests: { number: number }[] = [{ number: 1 }]) {
    return runBundle({
      eventName: 'check_suite',
      payload: { ...checkSuiteCompletedEvent, check_suite: { ...checkSuiteCompletedEvent.check_suite, pull_requests: pullRequests } },
      inputs: token,
      apiUrl: gh.url,
    })
  }

  describe('a pull request GitHub reports as', () => {
    it.each([
      ['merged', { merged: true }, 'already merged'],
      ['closed', { state: 'closed' }, 'closed'],
      ['locked', { locked: true }, 'locked'],
    ])('%s is skipped before its lgtm binding or mergeability is read', async (_, overrides, reason) => {
      gh.route('GET', `${repo}/pulls/1`, { status: 200, body: pr('clean', overrides) })

      const result = await checkSuite()

      expect(result.status, result.stdout).toBe(0)
      expect(result.errors).toEqual([])
      expect(result.stdout).toContain(`skipping pr #1: ${reason}`)
      expect(gh.requestsMatching('PUT', /./)).toEqual([])
      // the gate failed on an event, so tide asks the queue once whether its own entry must be dequeued
      expectRequests(configReads(), [pullRead, ownersProbe, queueRead])
    })
  })

  it('a mergeability still unknown after every retry is skipped as not mergeable (unknown)', async () => {
    gh.commitStatuses(repo, head, bound)
    gh.route('GET', `${repo}/pulls/1`, { status: 200, body: pr('unknown') })

    const result = await checkSuite()

    expect(result.status, result.stdout).toBe(0)
    expect(result.errors).toEqual([])
    for (const delay of [1000, 2000, 4000]) {
      expect(result.stdout).toContain(`mergeability of pr #1 is not computed yet, retrying in ${delay}ms`)
    }
    expect(result.stdout).toContain('mergeability of pr #1 is still unknown after 3 retries')
    expect(result.stdout).toContain('skipping pr #1: not mergeable (unknown)')
    expect(gh.requestsMatching('PUT', /./)).toEqual([])
    // the first read, then one re-read per retry
    expectRequests(configReads(), [pullRead, ownersProbe, bindingRead, queueRead, pullRead, pullRead, pullRead])
  })

  it('a head that moves while mergeability is computed is skipped, not merged', async () => {
    gh.commitStatuses(repo, head, bound)
    gh.routeSequence('GET', `${repo}/pulls/1`, [
      { status: 200, body: pr('unknown') },
      { status: 200, body: pr('clean', { head: { sha: 'movedsha' } }) },
    ])

    const result = await checkSuite()

    expect(result.status, result.stdout).toBe(0)
    expect(result.errors).toEqual([])
    expect(result.stdout).toContain('skipping pr #1: head moved during evaluation')
    expect(gh.requestsMatching('PUT', /./)).toEqual([])
    expectRequests(configReads(), [pullRead, ownersProbe, bindingRead, queueRead, pullRead])
  })

  describe('a merge GitHub refuses', () => {
    it('with 405 once a concurrent event merged it is reported as merged concurrently, exit 0', async () => {
      gh.commitStatuses(repo, head, bound)
      gh.routeSequence('GET', `${repo}/pulls/1`, [
        { status: 200, body: pr('clean') },
        { status: 200, body: pr('clean', { merged: true, state: 'closed' }) },
      ])
      gh.route('PUT', `${repo}/pulls/1/merge`, { status: 405, body: { message: 'Pull Request is not mergeable' } })

      const result = await checkSuite()

      expect(result.status, result.stdout).toBe(0)
      expect(result.errors).toEqual([])
      expect(result.stdout).toContain('pr #1 was merged concurrently')
      expect(result.stdout).not.toContain('could not merge pr #1')
      expect(gh.requestsMatching('PUT', /./)[0].body).toEqual({ merge_method: 'merge', sha: head })
      // the refused merge is followed by one re-read that finds the pull request merged
      expectRequests(configReads(), [pullRead, ownersProbe, bindingRead, queueRead, merge, pullRead])
    })

    it.each([
      ['Base branch was modified. Review and try the merge again.', 'base branch moved'],
      ['Head branch was modified. Review and try the merge again.', 'head moved'],
    ])('with 409 "%s" is skipped as %s, exit 0', async (message, reason) => {
      gh.commitStatuses(repo, head, bound)
      gh.route('GET', `${repo}/pulls/1`, { status: 200, body: pr('clean') })
      gh.route('PUT', `${repo}/pulls/1/merge`, { status: 409, body: { message } })

      const result = await checkSuite()

      expect(result.status, result.stdout).toBe(0)
      expect(result.errors).toEqual([])
      expect(result.stdout).toContain(`skipping pr #1: ${reason}`)
      expect(result.stdout).not.toContain('could not merge pr #1')
      expectRequests(configReads(), [pullRead, ownersProbe, bindingRead, queueRead, merge, pullRead])
    })

    it('whose re-read fails too is reported with GitHub\'s message and fails the run', async () => {
      gh.commitStatuses(repo, head, bound)
      gh.routeSequence('GET', `${repo}/pulls/1`, [
        { status: 200, body: pr('clean') },
        { status: 500, body: { message: 'boom' } },
      ])
      gh.route('PUT', `${repo}/pulls/1/merge`, { status: 500, body: { message: 'merge exploded' } })

      const result = await checkSuite()

      expect(result.status, result.stdout).toBe(1)
      expect(result.errors).toEqual([
        'could not merge pr #1: merge exploded',
        'error handling check_suite event: could not merge pull request(s) #1',
      ])
      expectRequests(configReads(), [pullRead, ownersProbe, bindingRead, queueRead, merge, pullRead])
    })
  })

  describe('check_suite', () => {
    it('without a head sha fails the run naming the payload', async () => {
      const result = await runBundle({
        eventName: 'check_suite',
        payload: { action: 'completed', check_suite: { conclusion: 'success' }, repository: checkSuiteCompletedEvent.repository },
        inputs: token,
        apiUrl: gh.url,
      })

      expect(result.status, result.stdout).toBe(1)
      expect(result.errors).toHaveLength(1)
      expect(result.errors[0]).toContain('error handling check_suite event: github context payload missing head sha: {"action":"completed","check_suite":{"conclusion":"success"}')
      expect(gh.requests).toEqual([])
    })

    it('naming no pull request, for a commit no open pull request has as its head, evaluates nothing', async () => {
      gh.route('GET', new RegExp(`^${repo}/pulls\\?`), (req) => {
        const page = new URL(req.path, gh.url).searchParams.get('page')
        return { status: 200, body: page === '1' ? [{ number: 2, head: { sha: 'other' } }] : [] }
      })

      const result = await checkSuite([])

      expect(result.status, result.stdout).toBe(0)
      expect(result.errors).toEqual([])
      expect(result.stdout).toContain('tide: no open pull request to evaluate')
      expectRequests(configReads(), [
        `GET ${repo}/pulls?state=open&per_page=100&page=1`,
        `GET ${repo}/pulls?state=open&per_page=100&page=2`,
      ])
    })
  })

  it('issue_comment /hold on a closed pull request applies the label; tide skips the closed pull request without reading it', async () => {
    gh.route('GET', `${repo}/labels`, { status: 200, body: [{ name: 'do-not-merge/hold' }] })
    gh.route('POST', `${repo}/issues/1/labels`, { status: 200, body: [] })
    const payload = prCommentEvent('/hold')

    const result = await runBundle({
      eventName: 'issue_comment',
      payload: { ...payload, issue: { ...payload.issue, state: 'closed' } },
      inputs: { ...token, 'prow-commands': '/hold' },
      apiUrl: gh.url,
    })

    expect(result.status, result.stdout).toBe(0)
    expect(result.errors).toEqual([])
    expect(result.stdout).toContain('tide: pull request #1 is closed')
    expect(gh.requestsMatching('POST', /\/issues\/1\/labels$/)[0].body).toEqual({ labels: ['do-not-merge/hold'] })
    expect(gh.requestsMatching('GET', /\/pulls\/1$/)).toEqual([])
  })
})

// the scheduled `sweep` and `lgtm` jobs overlap: both list the open pull requests and both reach the merge
// path, so tide evaluates each pull request once per run — the second job to arrive is skipped, not merged twice
describe('dist/index.js schedule with both the sweep and the lgtm jobs', () => {
  let gh: FakeGithub

  const head = pullReqListPulls[0].head.sha

  beforeAll(async () => {
    gh = await start()
  })
  beforeEach(() => gh.mergeQueueFallback({ pullRequestId: 'PR_none', headOid: head, enabled: false }))
  afterEach(() => gh.reset())
  afterAll(() => gh.close())

  it('evaluates a pull request both jobs list once: one merge, the other job skips it as already evaluated', async () => {
    const stamp = new Date().toISOString()
    const pr = {
      ...structuredClone(pullReqListPulls[0]),
      number: 1,
      labels: [{ name: 'lgtm' }],
      created_at: stamp,
      updated_at: stamp,
      requested_reviewers: [],
      assignees: [],
      draft: false,
      mergeable: true,
      mergeable_state: 'clean',
      head: { sha: head, repo: { full_name: 'Codertocat/Hello-World' } },
      base: { ref: 'master', sha: 'basesha' },
    }
    gh.route('GET', repo, { status: 200, body: { default_branch: 'master' } })
    gh.route('GET', new RegExp(`^${repo}/pulls\\?`), (req) => {
      const page = new URL(req.path, gh.url).searchParams.get('page')
      return { status: 200, body: page === '1' ? [pr] : [] }
    })
    gh.route('GET', `${repo}/pulls/1`, { status: 200, body: pr })
    gh.commitStatuses(repo, head, [{ context: 'prow/lgtm', state: 'success' }])
    gh.route('PUT', `${repo}/pulls/1/merge`, { status: 200, body: { merged: true } })

    const result = await runBundle({
      eventName: 'schedule',
      payload: {},
      inputs: { ...token, jobs: 'sweep lgtm' },
      apiUrl: gh.url,
    })

    expect(result.status, result.stdout).toBe(0)
    expect(result.errors).toEqual([])
    expect(result.stdout).toContain('merged pr #1')
    expect(result.stdout).toContain('skipping pr #1: already evaluated in this run')
    expect(gh.requestsMatching('PUT', /./)).toHaveLength(1)
    expect(gh.requestsMatching('PUT', /./)[0].body).toEqual({ merge_method: 'merge', sha: head })
    // the jobs run concurrently, so only the listings' presence is fixed, not their order
    expect(gh.requestsMatching('GET', /\/pulls\?state=open&sort=updated&direction=desc&per_page=100&page=1$/)).toHaveLength(1)
    expect(gh.requestsMatching('GET', /\/pulls\?state=open&page=1$/)).toHaveLength(1)
  })
})
