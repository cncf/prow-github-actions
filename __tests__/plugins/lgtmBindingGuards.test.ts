import type { Octokit } from '@octokit/rest'
import { Buffer } from 'node:buffer'
import * as core from '@actions/core'
import { http } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { bindLgtm, isLgtmBound, lgtmOnPullRequest } from '../../src/plugins/lgtmBinding'
import labelFileContents from '../fixtures/labels/labelFileContentsResp.json'
import pullReqOpenedEvent from '../fixtures/pullReq/pullReqOpenedEvent.json'
import * as utils from '../testUtils'

// Guards and log lines of src/plugins/lgtmBinding.ts that the rest of the
// suite reaches but never distinguishes from their mutation: each case here
// fails when the guarded expression is replaced by a constant, an operator is
// flipped, or the log call is removed.

const server = setupServer()
beforeAll(() => server.listen(utils.failOnUnhandledRequest))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

const repo = `${utils.api}/repos/Codertocat/Hello-World`
const headSha = pullReqOpenedEvent.pull_request.head.sha
const context = new utils.MockContext(pullReqOpenedEvent)

function labeled(payload: Record<string, unknown> = pullReqOpenedEvent) {
  return new utils.MockContext({ ...payload, action: 'labeled', label: { name: 'lgtm' }, sender: { login: 'alice', type: 'User' } })
}

function prowYaml(text: string) {
  const file = structuredClone(labelFileContents)
  file.content = Buffer.from(text).toString('base64')
  return http.get(utils.contentsUrl('.github/prow.yaml'), utils.mockResponse(200, file))
}

// an octokit whose statuses endpoints reject with a bare value: a hook or
// plugin can reject with anything, and isForbidden must not read .status off it
function rejectingWith(reason: unknown) {
  return {
    repos: {
      createCommitStatus: () => Promise.reject(reason),
      getCombinedStatusForRef: () => Promise.reject(reason),
    },
  } as unknown as Octokit
}

beforeEach(() => {
  utils.setupActionsEnv()
  vi.restoreAllMocks()
})

describe('lgtmOnPullRequest guards', () => {
  it('requires the github-token input before reading the configuration', async () => {
    delete process.env['INPUT_GITHUB-TOKEN']
    const status = new utils.ObserveRequest()
    server.use(http.post(`${repo}/statuses/${headSha}`, utils.mockResponse(201, {}, status)))

    await expect(lgtmOnPullRequest(labeled())).rejects.toThrow('Input required and not supplied: github-token')

    await expect(status.notCalled()).resolves.toBe('not called')
  })

  it('throws the missing-head error when the pull request has no head, not a property read failure', async () => {
    await expect(lgtmOnPullRequest(labeled({ pull_request: { number: 1 } }))).rejects.toThrow(/^github context payload missing pull request head: /)
  })

  it('bind_to_commit: false says so in the debug log', async () => {
    const status = new utils.ObserveRequest()
    server.use(
      ...utils.noOrgOrRepoConfigExcept('.github/prow.yaml'),
      prowYaml('lgtm:\n  bind_to_commit: false\n'),
      http.post(`${repo}/statuses/${headSha}`, utils.mockResponse(201, {}, status)),
    )
    const debug = vi.spyOn(core, 'debug').mockImplementation(() => {})

    await expect(lgtmOnPullRequest(labeled())).resolves.toBeUndefined()

    expect(debug).toHaveBeenCalledWith('lgtm: bind_to_commit is false')
    await expect(status.notCalled()).resolves.toBe('not called')
  })
})

describe('isForbidden on a rejection that is not an object', () => {
  it.each([
    ['null', null, 'null'],
    ['a string', 'boom', 'boom'],
    ['a number', 403, '403'],
  ])('bindLgtm wraps %s without the permission hint', async (_, reason, text) => {
    await expect(bindLgtm(rejectingWith(reason), context, 'abc', 'alice')).rejects.toThrow(`could not bind lgtm to abc: ${text}`)
  })

  it.each([
    ['null', null, 'null'],
    ['a string', 'boom', 'boom'],
    ['a number', 403, '403'],
  ])('isLgtmBound wraps %s without the permission hint', async (_, reason, text) => {
    await expect(isLgtmBound(rejectingWith(reason), context, 'abc')).rejects.toThrow(`could not read the prow/lgtm status of abc: ${text}`)
  })

  it('an object rejection without a status is not forbidden', async () => {
    await expect(bindLgtm(rejectingWith(new Error('plain')), context, 'abc', 'alice')).rejects.toThrow('could not bind lgtm to abc: Error: plain')
  })

  it('a status of 403 on a plain object is forbidden', async () => {
    await expect(bindLgtm(rejectingWith({ status: 403 }), context, 'abc', 'alice')).rejects.toThrow('cannot bind lgtm to the commit: grant `statuses: write`')
  })
})
