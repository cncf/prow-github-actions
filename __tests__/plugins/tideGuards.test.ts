import * as core from '@actions/core'
import { http } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { evaluateMerge, fetchMergeability, getPull, mergeOnce, tryMergePullRequest } from '../../src/plugins/tide'
import { resolveTide } from '../../src/utils/config'
import { newOctokit } from '../../src/utils/octokit'
import * as sleepModule from '../../src/utils/sleep'
import pullReqOpenedEvent from '../fixtures/pullReq/pullReqOpenedEvent.json'
import * as utils from '../testUtils'

// Guards of src/plugins/tide.ts that line coverage reaches but no other test
// would notice changing: each case here fails when the guard it names is
// removed or inverted.

const server = setupServer()
beforeAll(() => server.listen(utils.failOnUnhandledRequest))
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
    base: { ref: 'master', sha: 'basesha' },
    head: { sha: 'headsha' },
    ...overrides,
  }
}

function forkPull(labels: string[] = ['lgtm']) {
  return pull(labels, {
    head: { sha: 'headsha', repo: { full_name: 'dave/Hello-World' } },
    base: { ref: 'master', sha: 'basesha', repo: { full_name: 'Codertocat/Hello-World' } },
  })
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

function serveDiff(behind: string[], own: string[]) {
  const observe = { compare: new utils.ObserveRequest(), comment: new utils.ObserveRequest() }
  server.use(
    http.get(`${repo}/compare/headsha...master`, utils.mockResponse(200, { files: behind.map(filename => ({ filename, status: 'added' })) }, observe.compare)),
    http.get(`${repo}/pulls/1/files`, utils.mockResponse(200, own.map(filename => ({ filename, status: 'modified' })))),
    http.get(`${repo}/issues/1/comments`, utils.mockResponse(200, [])),
    http.post(`${repo}/issues/1/comments`, utils.mockResponse(201, {}, observe.comment)),
  )
  return observe
}

function serveGraphql(queue: utils.MergeQueueFixture = {}) {
  const { handler, calls } = utils.mergeQueueGraphql(queue)
  server.use(handler)
  return calls
}

let sleep: ReturnType<typeof vi.spyOn>
let octokit: ReturnType<typeof newOctokit>
let context: utils.MockContext

beforeEach(() => {
  utils.setupActionsEnv()
  server.use(utils.lgtmStatus())
  sleep = vi.spyOn(sleepModule, 'sleep').mockResolvedValue(undefined)
  octokit = newOctokit('some-token')
  context = new utils.MockContext(pullReqOpenedEvent)
  context.eventName = 'pull_request'
})

describe('mergeOnce reads the status of a refused merge defensively', () => {
  it('a null rejection is reported as failed, not rethrown', async () => {
    vi.spyOn(octokit.pulls, 'merge').mockRejectedValue(null)

    await expect(mergeOnce(octokit, context, 1, tide, 'headsha')).resolves.toEqual({ result: 'failed', message: 'null', status: undefined })
  })

  it('a status that is not a number is dropped, the message kept', async () => {
    vi.spyOn(octokit.pulls, 'merge').mockRejectedValue(Object.assign(new Error('moved'), { status: '409' }))

    await expect(mergeOnce(octokit, context, 1, tide, 'headsha')).resolves.toEqual({ result: 'failed', message: 'moved', status: undefined })
  })
})

describe('the fork workflow diagnosis is reserved for a 403', () => {
  it('a fork pull request whose merge fails with another status is reported failed without comparing', async () => {
    servePull(forkPull())
    observeMerge(500, { message: 'Server Error' })
    serveGraphql({ enabled: false })
    const diff = serveDiff(['.github/workflows/ci.yml'], [])
    const error = vi.spyOn(core, 'error').mockImplementation(() => {})

    await expect(tryMergePullRequest(octokit, context, 1, tide)).resolves.toBe('failed')
    await expect(diff.compare.notCalled()).resolves.toBe('not called')
    await expect(diff.comment.notCalled()).resolves.toBe('not called')
    expect(error).toHaveBeenCalledWith(expect.stringContaining('Server Error'))
  })

  it('lists the workflow files the branch lacks in sorted order, whatever order the compare returned them', async () => {
    servePull(forkPull())
    observeMerge(403, { message: 'Resource not accessible by integration' })
    serveGraphql({ enabled: false })
    const diff = serveDiff(['.github/workflows/release.yml', 'README.md', '.github/workflows/ci.yml'], [])
    vi.spyOn(core, 'warning').mockImplementation(() => {})

    await expect(tryMergePullRequest(octokit, context, 1, tide)).resolves.toBe('skipped')
    const body = (await diff.comment.body()).body as string
    expect(body).toContain('workflow files (`.github/workflows/ci.yml`, `.github/workflows/release.yml`) that the branch does not contain.')
  })
})

describe('an unknown mergeable_state is retried on its own', () => {
  it('re-reads when GitHub answers mergeable_state unknown with mergeable already set', async () => {
    const gets = servePull(pull([], { mergeable_state: 'unknown', mergeable: true }), pull([], { mergeable_state: 'clean' }))

    await expect(fetchMergeability(octokit, context, 1, { retryIf: () => true, initial: await getPull(octokit, context, 1) })).resolves.toMatchObject({ state: 'clean', mergeable: true })
    expect(gets).toHaveLength(2)
    expect(sleep.mock.calls.map(call => call[0])).toEqual([1000])
  })
})

describe('on a merge queue branch', () => {
  it('stops retrying an unknown state once the gate breaks on the re-read, and does not enqueue', async () => {
    const unknown = { mergeable: null, mergeable_state: 'unknown' }
    const gets = servePull(pull(['lgtm'], unknown), pull([], unknown))
    const calls = serveGraphql({ enabled: true })
    const info = vi.spyOn(core, 'info')

    await expect(evaluateMerge(octokit, context, 1, tide)).resolves.toEqual({ result: 'skipped', reason: 'missing lgtm' })
    expect(gets).toHaveLength(2)
    expect(sleep.mock.calls.map(call => call[0])).toEqual([1000])
    expect(utils.graphqlMutations(calls, 'enqueuePullRequest')).toHaveLength(0)
    expect(info).toHaveBeenCalledWith('skipping pr #1: missing lgtm')
    expect(info).not.toHaveBeenCalledWith(expect.stringContaining('still unknown'))
  })

  it('a gate break on a pr that is in the queue without an entry is left alone as an unknown actor', async () => {
    servePull(pull([]))
    const calls = serveGraphql({ inQueue: true, entry: null })
    const debug = vi.spyOn(core, 'debug')

    await expect(evaluateMerge(octokit, context, 1, tide)).resolves.toEqual({ result: 'skipped', reason: 'missing lgtm' })
    expect(debug).toHaveBeenCalledWith('pr #1 was enqueued by an unknown actor; leaving it in the queue')
    expect(utils.graphqlMutations(calls, 'dequeuePullRequest')).toHaveLength(0)
  })
})
