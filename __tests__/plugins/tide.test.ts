import { Buffer } from 'node:buffer'
import * as core from '@actions/core'
import { http } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { fetchMergeability, tideOnCheckSuite, tideOnPullRequest, tideOnReview, tryMergePullRequest, unknownRetryDelaysMs } from '../../src/plugins/tide'
import { resolveTide } from '../../src/utils/config'
import { newOctokit } from '../../src/utils/octokit'
import * as sleepModule from '../../src/utils/sleep'
import labelFileContents from '../fixtures/labels/labelFileContentsResp.json'
import checkSuiteCompletedEvent from '../fixtures/pullReq/checkSuiteCompletedEvent.json'
import pullReqOpenedEvent from '../fixtures/pullReq/pullReqOpenedEvent.json'
import reviewSubmittedEvent from '../fixtures/pullReq/pullReqReviewSubmittedEvent.json'
import * as utils from '../testUtils'

const server = setupServer()
beforeAll(() =>
  server.listen({
    onUnhandledRequest: 'error',
  }),
)
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

const repo = `${utils.api}/repos/Codertocat/Hello-World`
const tide = resolveTide({ merge_method: 'squash' })

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

// serves GET /pulls/1 with one body per call, repeating the last one
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

let sleep: ReturnType<typeof vi.spyOn>
let octokit: ReturnType<typeof newOctokit>
let context: utils.MockContext

beforeEach(() => {
  utils.setupActionsEnv()
  sleep = vi.spyOn(sleepModule, 'sleep').mockResolvedValue(undefined)
  octokit = newOctokit('some-token')
  context = new utils.MockContext(pullReqOpenedEvent)
})

const unknown = { mergeable: null, mergeable_state: 'unknown' }

describe('fetchMergeability', () => {
  it('maps the pull request fields', async () => {
    servePull(pull(['lgtm', 'kind/bug'], { locked: true }))

    await expect(fetchMergeability(octokit, context, 1)).resolves.toEqual({
      state: 'clean',
      mergeable: true,
      labels: ['lgtm', 'kind/bug'],
      draft: false,
      locked: true,
      merged: false,
      state_open: true,
      sha: 'headsha',
    })
    expect(sleep).not.toHaveBeenCalled()
  })

  it('re-reads an unknown state after 1, 2 and 4 seconds until it is computed', async () => {
    const gets = servePull(pull([], unknown), pull([], unknown), pull([], { mergeable_state: 'behind' }))

    await expect(fetchMergeability(octokit, context, 1)).resolves.toMatchObject({ state: 'behind', mergeable: true })
    expect(gets).toHaveLength(3)
    expect(sleep.mock.calls.map(call => call[0])).toEqual([1000, 2000])
  })

  it('gives up after the last wait and returns the unknown state', async () => {
    const gets = servePull(pull([], unknown))
    const info = vi.spyOn(core, 'info')

    await expect(fetchMergeability(octokit, context, 1)).resolves.toMatchObject({ state: 'unknown', mergeable: null })
    expect(gets).toHaveLength(unknownRetryDelaysMs.length + 1)
    expect(sleep.mock.calls.map(call => call[0])).toEqual(unknownRetryDelaysMs)
    expect(info).toHaveBeenCalledWith('mergeability of pr #1 is still unknown after 3 retries')
  })

  it('treats a null mergeable as unknown even when the state says otherwise', async () => {
    const gets = servePull(pull([], { mergeable: null, mergeable_state: 'clean' }), pull([]))

    await expect(fetchMergeability(octokit, context, 1)).resolves.toMatchObject({ mergeable: true })
    expect(gets).toHaveLength(2)
  })

  it('stops retrying when retryIf says the wait is pointless', async () => {
    const gets = servePull(pull([], unknown))

    await expect(fetchMergeability(octokit, context, 1, { retryIf: () => false })).resolves.toMatchObject({ state: 'unknown' })
    expect(gets).toHaveLength(1)
    expect(sleep).not.toHaveBeenCalled()
  })
})

describe('tryMergePullRequest', () => {
  it('merges a clean pr that passes the gate with the configured merge method', async () => {
    const gets = servePull(pull(['lgtm']))
    const merge = observeMerge()
    const info = vi.spyOn(core, 'info')

    await expect(tryMergePullRequest(octokit, context, 1, tide)).resolves.toBe('merged')
    await expect(merge.called()).resolves.toBe('called')
    expect(await merge.body()).toEqual({ merge_method: 'squash' })
    expect(gets).toHaveLength(1)
    expect(info).toHaveBeenCalledWith('merged pr #1')
  })

  it('merges a has_hooks pr', async () => {
    servePull(pull(['lgtm'], { mergeable_state: 'has_hooks' }))
    const merge = observeMerge()

    await expect(tryMergePullRequest(octokit, context, 1, tide)).resolves.toBe('merged')
    await expect(merge.called()).resolves.toBe('called')
  })

  it('does not merge a blocked pr and logs the state', async () => {
    servePull(pull(['lgtm'], { mergeable_state: 'blocked' }))
    const merge = observeMerge()
    const info = vi.spyOn(core, 'info')

    await expect(tryMergePullRequest(octokit, context, 1, tide)).resolves.toBe('skipped')
    await expect(merge.notCalled()).resolves.toBe('not called')
    expect(info).toHaveBeenCalledWith('skipping pr #1: not mergeable (blocked)')
  })

  it.each(['dirty', 'behind', 'unstable', 'draft'])('does not merge a %s pr', async (state) => {
    const gets = servePull(pull(['lgtm'], { mergeable_state: state, draft: state === 'draft' }))
    const merge = observeMerge()
    const info = vi.spyOn(core, 'info')

    await expect(tryMergePullRequest(octokit, context, 1, tide)).resolves.toBe('skipped')
    await expect(merge.notCalled()).resolves.toBe('not called')
    expect(info).toHaveBeenCalledWith(`skipping pr #1: not mergeable (${state})`)
    expect(gets).toHaveLength(1)
    expect(sleep).not.toHaveBeenCalled()
  })

  it('waits for an unknown state when the gate passes, then merges', async () => {
    const gets = servePull(pull(['lgtm'], unknown), pull(['lgtm']))
    const merge = observeMerge()

    await expect(tryMergePullRequest(octokit, context, 1, tide)).resolves.toBe('merged')
    await expect(merge.called()).resolves.toBe('called')
    expect(gets).toHaveLength(2)
    expect(sleep).toHaveBeenCalledExactlyOnceWith(1000)
  })

  it('skips a pr whose state is still unknown after the retries', async () => {
    const gets = servePull(pull(['lgtm'], unknown))
    const merge = observeMerge()
    const info = vi.spyOn(core, 'info')

    await expect(tryMergePullRequest(octokit, context, 1, tide)).resolves.toBe('skipped')
    await expect(merge.notCalled()).resolves.toBe('not called')
    expect(gets).toHaveLength(4)
    expect(info).toHaveBeenCalledWith('skipping pr #1: not mergeable (unknown)')
  })

  it.each([
    [['kind/bug'], 'missing lgtm'],
    [['lgtm', 'do-not-merge/hold'], 'blocked by do-not-merge/hold'],
  ])('does not wait for an unknown state when the gate fails on %j', async (labels, reason) => {
    const gets = servePull(pull(labels, unknown))
    const merge = observeMerge()
    const info = vi.spyOn(core, 'info')

    await expect(tryMergePullRequest(octokit, context, 1, tide)).resolves.toBe('skipped')
    await expect(merge.notCalled()).resolves.toBe('not called')
    expect(gets).toHaveLength(1)
    expect(sleep).not.toHaveBeenCalled()
    expect(info).toHaveBeenCalledWith(`skipping pr #1: ${reason}`)
  })

  it.each([
    ['closed', { state: 'closed' }],
    ['already merged', { state: 'closed', merged: true }],
    ['locked', { locked: true }],
  ])('skips a %s pr without waiting', async (reason, overrides) => {
    const gets = servePull(pull(['lgtm'], { ...unknown, ...overrides }))
    const merge = observeMerge()
    const info = vi.spyOn(core, 'info')

    await expect(tryMergePullRequest(octokit, context, 1, tide)).resolves.toBe('skipped')
    await expect(merge.notCalled()).resolves.toBe('not called')
    expect(gets).toHaveLength(1)
    expect(sleep).not.toHaveBeenCalled()
    expect(info).toHaveBeenCalledWith(`skipping pr #1: ${reason}`)
  })

  it('treats a refused merge as skipped when a re-read shows the pr merged concurrently', async () => {
    const gets = servePull(pull(['lgtm']), pull(['lgtm'], { state: 'closed', merged: true }))
    const merge = observeMerge(405, { message: 'Pull Request is not mergeable' })
    const info = vi.spyOn(core, 'info')
    const error = vi.spyOn(core, 'error').mockImplementation(() => {})

    await expect(tryMergePullRequest(octokit, context, 1, tide)).resolves.toBe('skipped')
    await expect(merge.called()).resolves.toBe('called')
    expect(gets).toHaveLength(2)
    expect(info).toHaveBeenCalledWith('pr #1 was merged concurrently')
    expect(error).not.toHaveBeenCalled()
  })

  it('reports a refused merge as failed when the pr is still open', async () => {
    const gets = servePull(pull(['lgtm']))
    const merge = observeMerge(405, { message: 'Pull Request is not mergeable' })
    const error = vi.spyOn(core, 'error').mockImplementation(() => {})

    await expect(tryMergePullRequest(octokit, context, 1, tide)).resolves.toBe('failed')
    await expect(merge.called()).resolves.toBe('called')
    expect(gets).toHaveLength(2)
    expect(error).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('could not merge pr #1: Pull Request is not mergeable'))
  })

  it('reports a refused merge as failed when the re-read fails too', async () => {
    let calls = 0
    server.use(
      http.get(`${repo}/pulls/1`, () => {
        calls++
        return calls === 1
          ? new Response(JSON.stringify(pull(['lgtm'])), { status: 200, headers: { 'Content-Type': 'application/json' } })
          : new Response(JSON.stringify({ message: 'boom' }), { status: 500, headers: { 'Content-Type': 'application/json' } })
      }),
    )
    observeMerge(409, { message: 'Base branch was modified' })
    const error = vi.spyOn(core, 'error').mockImplementation(() => {})

    await expect(tryMergePullRequest(octokit, context, 1, tide)).resolves.toBe('failed')
    expect(calls).toBe(2)
    expect(error).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('Base branch was modified'))
  })
})

function prowYaml(text: string) {
  const file = structuredClone(labelFileContents)
  file.content = Buffer.from(text).toString('base64')
  return http.get(utils.contentsUrl('.github/prow.yaml'), utils.mockResponse(200, file))
}

function prEvent(action: string, extra: Record<string, unknown> = {}) {
  return new utils.MockContext({ ...pullReqOpenedEvent, action, ...extra })
}

describe('tideOnPullRequest', () => {
  beforeEach(() => {
    server.use(...utils.noOrgOrRepoConfigExcept(), utils.defaultBranchTree())
  })

  it('labeled lgtm: merges a clean pr', async () => {
    servePull(pull(['lgtm']))
    const merge = observeMerge()

    await expect(tideOnPullRequest(prEvent('labeled', { label: { name: 'lgtm' } }))).resolves.toBeUndefined()
    await expect(merge.called()).resolves.toBe('called')
    expect(await merge.body()).toEqual({ merge_method: 'merge' })
  })

  it('labeled kind/bug on a pr without lgtm: one read, no merge', async () => {
    const gets = servePull(pull(['kind/bug']))
    const merge = observeMerge()

    await expect(tideOnPullRequest(prEvent('labeled', { label: { name: 'kind/bug' } }))).resolves.toBeUndefined()
    await expect(merge.notCalled()).resolves.toBe('not called')
    expect(gets).toHaveLength(1)
  })

  it('reads the labels from the api, not from the payload', async () => {
    servePull(pull(['lgtm', 'do-not-merge/hold']))
    const merge = observeMerge()
    const info = vi.spyOn(core, 'info')

    await expect(tideOnPullRequest(prEvent('labeled', { label: { name: 'lgtm' }, pull_request: { ...pullReqOpenedEvent.pull_request, labels: [{ name: 'lgtm' }] } }))).resolves.toBeUndefined()
    await expect(merge.notCalled()).resolves.toBe('not called')
    expect(info).toHaveBeenCalledWith('skipping pr #1: blocked by do-not-merge/hold')
  })

  it.each(['unlabeled', 'reopened', 'ready_for_review', 'edited'])('%s: evaluates the pr', async (action) => {
    const gets = servePull(pull(['lgtm']))
    const merge = observeMerge()

    await expect(tideOnPullRequest(prEvent(action))).resolves.toBeUndefined()
    await expect(merge.called()).resolves.toBe('called')
    expect(gets).toHaveLength(1)
  })

  it.each(['opened', 'synchronize', 'closed', 'assigned'])('%s: does not read the pr', async (action) => {
    const gets = servePull(pull(['lgtm']))
    const merge = observeMerge()
    const debug = vi.spyOn(core, 'debug')

    await expect(tideOnPullRequest(prEvent(action))).resolves.toBeUndefined()
    await expect(merge.notCalled()).resolves.toBe('not called')
    expect(gets).toHaveLength(0)
    expect(debug).toHaveBeenCalledWith(`tide: skipping ${action} action`)
  })

  it('uses tide.merge_method from the configuration', async () => {
    server.use(prowYaml('tide:\n  merge_method: rebase\n'))
    servePull(pull(['lgtm']))
    const merge = observeMerge()

    await tideOnPullRequest(prEvent('labeled'))
    await expect(merge.called()).resolves.toBe('called')
    expect(await merge.body()).toEqual({ merge_method: 'rebase' })
  })

  it('merge_on_events: false makes the handler a no-op after reading the configuration', async () => {
    server.use(prowYaml('tide:\n  merge_on_events: false\n'))
    const gets = servePull(pull(['lgtm']))
    const merge = observeMerge()

    await expect(tideOnPullRequest(prEvent('labeled'))).resolves.toBeUndefined()
    await expect(merge.notCalled()).resolves.toBe('not called')
    expect(gets).toHaveLength(0)
  })

  it('throws when the merge is refused so the run fails', async () => {
    servePull(pull(['lgtm']))
    observeMerge(405, { message: 'Pull Request is not mergeable' })
    vi.spyOn(core, 'error').mockImplementation(() => {})

    await expect(tideOnPullRequest(prEvent('labeled'))).rejects.toThrow('could not merge pull request(s) #1')
  })

  it('throws when the payload has no pull request', async () => {
    await expect(tideOnPullRequest(new utils.MockContext({ action: 'labeled' }))).rejects.toThrow('missing pull request')
  })

  describe('on a repository with OWNERS files', () => {
    beforeEach(() => {
      server.use(utils.defaultBranchTree(['OWNERS', 'sdk/OWNERS']))
    })

    it('labeled lgtm without approved: one read, no merge, names the missing label', async () => {
      const gets = servePull(pull(['lgtm']))
      const merge = observeMerge()
      const info = vi.spyOn(core, 'info')

      await expect(tideOnPullRequest(prEvent('labeled', { label: { name: 'lgtm' } }))).resolves.toBeUndefined()
      await expect(merge.notCalled()).resolves.toBe('not called')
      expect(gets).toHaveLength(1)
      expect(info).toHaveBeenCalledWith('skipping pr #1: missing approved')
    })

    it('labeled approved with lgtm present: merges', async () => {
      servePull(pull(['lgtm', 'approved']))
      const merge = observeMerge()

      await expect(tideOnPullRequest(prEvent('labeled', { label: { name: 'approved' } }))).resolves.toBeUndefined()
      await expect(merge.called()).resolves.toBe('called')
    })

    it('a configured tide.labels wins and the tree is not read', async () => {
      const observeTree = new utils.ObserveRequest()
      server.use(prowYaml('tide:\n  labels: [lgtm]\n'), utils.defaultBranchTree(['OWNERS'], observeTree))
      servePull(pull(['lgtm']))
      const merge = observeMerge()

      await expect(tideOnPullRequest(prEvent('labeled', { label: { name: 'lgtm' } }))).resolves.toBeUndefined()
      await expect(merge.called()).resolves.toBe('called')
      await expect(observeTree.notCalled()).resolves.toBe('not called')
    })

    it('reads the tree once for several pull requests of one run', async () => {
      let trees = 0
      server.use(http.get(`${repo}/git/trees/master`, () => {
        trees++
        return new Response(JSON.stringify({ sha: 'x', truncated: false, tree: [{ path: 'OWNERS', type: 'blob', sha: 'a' }] }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }))
      server.use(
        http.get(`${repo}/pulls/:number`, ({ params }) => new Response(JSON.stringify(pull(['lgtm'], { number: Number(params.number) })), { status: 200, headers: { 'Content-Type': 'application/json' } })),
      )
      const context = new utils.MockContext({ ...checkSuiteCompletedEvent, check_suite: { ...checkSuiteCompletedEvent.check_suite, pull_requests: [{ number: 1 }, { number: 2 }] } })
      context.eventName = 'check_suite'
      const info = vi.spyOn(core, 'info')

      await expect(tideOnCheckSuite(context)).resolves.toBeUndefined()
      expect(trees).toBe(1)
      expect(info).toHaveBeenCalledWith('skipping pr #1: missing approved')
      expect(info).toHaveBeenCalledWith('skipping pr #2: missing approved')
    })
  })
})

describe('tideOnReview', () => {
  beforeEach(() => {
    server.use(...utils.noOrgOrRepoConfigExcept(), utils.defaultBranchTree())
  })

  it.each(['submitted', 'dismissed'])('%s: evaluates the reviewed pr', async (action) => {
    const gets = servePull(pull(['lgtm']))
    const merge = observeMerge()

    await expect(tideOnReview(new utils.MockContext({ ...reviewSubmittedEvent, action }))).resolves.toBeUndefined()
    await expect(merge.called()).resolves.toBe('called')
    expect(gets).toHaveLength(1)
  })

  it('edited: does not read the pr', async () => {
    const gets = servePull(pull(['lgtm']))

    await expect(tideOnReview(new utils.MockContext({ ...reviewSubmittedEvent, action: 'edited' }))).resolves.toBeUndefined()
    expect(gets).toHaveLength(0)
  })
})

describe('tideOnCheckSuite', () => {
  const sha = checkSuiteCompletedEvent.check_suite.head_sha

  function suiteEvent(overrides: Record<string, unknown> = {}, eventName = 'check_suite') {
    const context = new utils.MockContext({
      ...checkSuiteCompletedEvent,
      check_suite: { ...checkSuiteCompletedEvent.check_suite, ...overrides },
    })
    context.eventName = eventName
    return context
  }

  function servePulls(prs: { number: number, sha: string }[]) {
    const seen: string[] = []
    server.use(
      http.get(`${repo}/pulls`, ({ request }) => {
        const url = new URL(request.url)
        seen.push(url.search)
        const body = url.searchParams.get('page') === '1' ? prs.map(pr => ({ number: pr.number, head: { sha: pr.sha } })) : []
        return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }),
    )
    return seen
  }

  beforeEach(() => {
    server.use(...utils.noOrgOrRepoConfigExcept(), utils.defaultBranchTree())
  })

  it('completed success with pull_requests in the payload: evaluates them without listing', async () => {
    const gets = servePull(pull(['lgtm']))
    const merge = observeMerge()
    const seen = servePulls([])

    await expect(tideOnCheckSuite(suiteEvent({ pull_requests: [{ number: 1 }] }))).resolves.toBeUndefined()
    await expect(merge.called()).resolves.toBe('called')
    expect(gets).toHaveLength(1)
    expect(seen).toEqual([])
  })

  it('completed success with no pull_requests: looks the open prs up by head sha', async () => {
    const gets = servePull(pull(['lgtm']))
    const merge = observeMerge()
    const seen = servePulls([{ number: 1, sha }, { number: 3, sha: 'other' }])

    await expect(tideOnCheckSuite(suiteEvent())).resolves.toBeUndefined()
    await expect(merge.called()).resolves.toBe('called')
    expect(gets).toHaveLength(1)
    expect(seen).toEqual(['?state=open&per_page=100&page=1', '?state=open&per_page=100&page=2'])
  })

  it('no open pr has the sha: nothing to evaluate', async () => {
    const gets = servePull(pull(['lgtm']))
    servePulls([])
    const debug = vi.spyOn(core, 'debug')

    await expect(tideOnCheckSuite(suiteEvent())).resolves.toBeUndefined()
    expect(gets).toHaveLength(0)
    expect(debug).toHaveBeenCalledWith('tide: no open pull request to evaluate')
  })

  it.each(['failure', 'cancelled', 'timed_out', 'action_required'])('conclusion %s: makes no api call', async (conclusion) => {
    const gets = servePull(pull(['lgtm']))
    const seen = servePulls([{ number: 1, sha }])

    await expect(tideOnCheckSuite(suiteEvent({ conclusion, pull_requests: [{ number: 1 }] }))).resolves.toBeUndefined()
    expect(gets).toHaveLength(0)
    expect(seen).toEqual([])
  })

  it.each(['success', 'neutral', 'skipped'])('conclusion %s: evaluates', async (conclusion) => {
    servePull(pull(['lgtm']))
    const merge = observeMerge()

    await tideOnCheckSuite(suiteEvent({ conclusion, pull_requests: [{ number: 1 }] }))
    await expect(merge.called()).resolves.toBe('called')
  })

  it('status success: looks the prs up by the payload sha', async () => {
    servePull(pull(['lgtm']))
    const merge = observeMerge()
    const seen = servePulls([{ number: 1, sha }])
    const context = new utils.MockContext({ sha, state: 'success', context: 'ci/lint', repository: checkSuiteCompletedEvent.repository })
    context.eventName = 'status'

    await expect(tideOnCheckSuite(context)).resolves.toBeUndefined()
    await expect(merge.called()).resolves.toBe('called')
    expect(seen).toHaveLength(2)
  })

  it.each(['pending', 'failure', 'error'])('status %s: makes no api call', async (state) => {
    const seen = servePulls([{ number: 1, sha }])
    const context = new utils.MockContext({ sha, state, context: 'ci/lint', repository: checkSuiteCompletedEvent.repository })
    context.eventName = 'status'

    await expect(tideOnCheckSuite(context)).resolves.toBeUndefined()
    expect(seen).toEqual([])
  })

  it('merge_on_events: false skips the lookup', async () => {
    server.use(prowYaml('tide:\n  merge_on_events: false\n'))
    const seen = servePulls([{ number: 1, sha }])

    await expect(tideOnCheckSuite(suiteEvent())).resolves.toBeUndefined()
    expect(seen).toEqual([])
  })

  it('lists every failed merge in the error', async () => {
    server.use(
      http.get(`${repo}/pulls/:number`, ({ params }) => new Response(JSON.stringify(pull(['lgtm'], { number: Number(params.number) })), { status: 200, headers: { 'Content-Type': 'application/json' } })),
      http.put(`${repo}/pulls/:number/merge`, utils.mockResponse(405, { message: 'Pull Request is not mergeable' })),
    )
    vi.spyOn(core, 'error').mockImplementation(() => {})

    await expect(tideOnCheckSuite(suiteEvent({ pull_requests: [{ number: 1 }, { number: 2 }] }))).rejects.toThrow('could not merge pull request(s) #1, #2')
  })

  it('throws when the payload has no sha', async () => {
    const context = new utils.MockContext({ action: 'completed' })
    context.eventName = 'check_suite'
    await expect(tideOnCheckSuite(context)).rejects.toThrow('missing head sha')
  })
})
