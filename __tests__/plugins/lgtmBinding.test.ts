import { Buffer } from 'node:buffer'
import * as core from '@actions/core'
import { http } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { bindLgtm, isLgtmBound, lgtmOnPullRequest, lgtmSettings, unbindLgtm } from '../../src/plugins/lgtmBinding'
import { mergeProwConfig } from '../../src/utils/config'
import { newOctokit } from '../../src/utils/octokit'
import labelFileContents from '../fixtures/labels/labelFileContentsResp.json'
import pullReqOpenedEvent from '../fixtures/pullReq/pullReqOpenedEvent.json'
import * as utils from '../testUtils'

const server = setupServer()
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

const repo = `${utils.api}/repos/Codertocat/Hello-World`
const headSha = pullReqOpenedEvent.pull_request.head.sha

function labeled(label: string, sender: Record<string, unknown> = { login: 'alice', type: 'User' }, action = 'labeled') {
  return new utils.MockContext({ ...pullReqOpenedEvent, action, label: { name: label }, sender })
}

function prowYaml(text: string) {
  const file = structuredClone(labelFileContents)
  file.content = Buffer.from(text).toString('base64')
  return http.get(utils.contentsUrl('.github/prow.yaml'), utils.mockResponse(200, file))
}

beforeEach(() => {
  utils.setupActionsEnv()
  server.use(...utils.noOrgOrRepoConfigExcept())
})

describe('lgtmSettings', () => {
  it('binds by default and honours lgtm.bind_to_commit', () => {
    expect(lgtmSettings({ ...mergeProwConfig({}, {}), sources: [] })).toEqual({ bind_to_commit: true })
    expect(lgtmSettings({ ...mergeProwConfig({}, { lgtm: { bind_to_commit: false } }), sources: [] })).toEqual({ bind_to_commit: false })
  })
})

describe('lgtmOnPullRequest', () => {
  it('labeled lgtm by a human binds the label to the payload head', async () => {
    const status = new utils.ObserveRequest()
    server.use(http.post(`${repo}/statuses/${headSha}`, utils.mockResponse(201, {}, status)))
    const info = vi.spyOn(core, 'info')

    await expect(lgtmOnPullRequest(labeled('LGTM'))).resolves.toBeUndefined()

    await expect(status.called()).resolves.toBe('called')
    expect(await status.body()).toEqual({
      state: 'success',
      context: 'prow/lgtm',
      description: `lgtm by alice at ${headSha.slice(0, 7)}`,
      target_url: pullReqOpenedEvent.pull_request.html_url,
    })
    expect(info).toHaveBeenCalledWith(`lgtm: bound the hand-applied label on #1 to ${headSha.slice(0, 7)}`)
  })

  it.each([
    ['github-actions[bot]', { login: 'github-actions[bot]', type: 'Bot' }],
    ['another app', { login: 'some-app[bot]', type: 'Bot' }],
  ])('labeled lgtm by %s makes no call: the bot records its own bindings', async (_, sender) => {
    const status = new utils.ObserveRequest()
    server.use(http.post(`${repo}/statuses/${headSha}`, utils.mockResponse(201, {}, status)))
    const debug = vi.spyOn(core, 'debug')

    await expect(lgtmOnPullRequest(labeled('lgtm', sender))).resolves.toBeUndefined()

    await expect(status.notCalled()).resolves.toBe('not called')
    expect(debug).toHaveBeenCalledWith(`lgtm: labeled by ${sender.login}, a bot; nothing to bind`)
  })

  it.each([
    ['labeled kind/bug', labeled('kind/bug')],
    ['unlabeled lgtm', labeled('lgtm', { login: 'alice', type: 'User' }, 'unlabeled')],
    ['opened', new utils.MockContext(pullReqOpenedEvent)],
  ])('%s makes no call', async (_, context) => {
    const status = new utils.ObserveRequest()
    server.use(http.post(`${repo}/statuses/${headSha}`, utils.mockResponse(201, {}, status)))

    await expect(lgtmOnPullRequest(context)).resolves.toBeUndefined()

    await expect(status.notCalled()).resolves.toBe('not called')
  })

  it('bind_to_commit: false reads the configuration and binds nothing', async () => {
    const status = new utils.ObserveRequest()
    server.use(prowYaml('lgtm:\n  bind_to_commit: false\n'), http.post(`${repo}/statuses/${headSha}`, utils.mockResponse(201, {}, status)))

    await expect(lgtmOnPullRequest(labeled('lgtm'))).resolves.toBeUndefined()

    await expect(status.notCalled()).resolves.toBe('not called')
  })

  it('a 403 on the status rejects with the permission to grant', async () => {
    server.use(http.post(`${repo}/statuses/${headSha}`, utils.mockResponse(403, { message: 'Resource not accessible by integration' })))

    await expect(lgtmOnPullRequest(labeled('lgtm'))).rejects.toThrow('cannot bind lgtm to the commit: grant `statuses: write` to the workflow (or set `lgtm.bind_to_commit: false`)')
  })

  it('throws when the payload has no head', async () => {
    await expect(lgtmOnPullRequest(new utils.MockContext({ action: 'labeled', label: { name: 'lgtm' }, sender: { login: 'alice' } }))).rejects.toThrow('missing pull request head')
  })
})

describe('the binding primitives', () => {
  const octokit = newOctokit('some-token')
  const context = new utils.MockContext(pullReqOpenedEvent)

  it('bindLgtm truncates the description to 140 characters and omits target_url when there is none', async () => {
    const status = new utils.ObserveRequest()
    server.use(http.post(`${repo}/statuses/abc`, utils.mockResponse(201, {}, status)))

    await bindLgtm(octokit, context, 'abc', 'x'.repeat(200))

    const body = await status.body()
    expect(body.description).toHaveLength(140)
    expect(body).not.toHaveProperty('target_url')
  })

  it('unbindLgtm warns instead of throwing', async () => {
    server.use(http.post(`${repo}/statuses/abc`, utils.mockResponse(500, { message: 'boom' })))
    const warning = vi.spyOn(core, 'warning').mockImplementation(() => {})

    await expect(unbindLgtm(octokit, context, 'abc', 'why')).resolves.toBeUndefined()
    expect(warning).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('could not set the prow/lgtm status of abc to pending: '))
  })

  it.each([
    ['no statuses', [], false],
    ['other contexts only', [{ context: 'ci/lint', state: 'success' }], false],
    ['prow/lgtm pending', [{ context: 'prow/lgtm', state: 'pending' }], false],
    ['prow/lgtm success', [{ context: 'ci/lint', state: 'failure' }, { context: 'prow/lgtm', state: 'success' }], true],
  ])('isLgtmBound with %s', async (_, statuses, bound) => {
    server.use(http.get(`${repo}/commits/abc/status`, utils.mockResponse(200, { state: 'x', statuses })))

    await expect(isLgtmBound(octokit, context, 'abc')).resolves.toBe(bound)
  })

  it('isLgtmBound wraps any other error without the permission hint', async () => {
    server.use(http.get(`${repo}/commits/abc/status`, utils.mockResponse(500, { message: 'boom' })))

    await expect(isLgtmBound(octokit, context, 'abc')).rejects.toThrow(/^could not read the prow\/lgtm status of abc: HttpError/)
  })
})
