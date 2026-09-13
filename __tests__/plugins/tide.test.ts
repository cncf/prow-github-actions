import * as core from '@actions/core'
import { http } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { fetchMergeability, tryMergePullRequest, unknownRetryDelaysMs } from '../../src/plugins/tide'
import { resolveTide } from '../../src/utils/config'
import { newOctokit } from '../../src/utils/octokit'
import * as sleepModule from '../../src/utils/sleep'
import pullReqOpenedEvent from '../fixtures/pullReq/pullReqOpenedEvent.json'
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
