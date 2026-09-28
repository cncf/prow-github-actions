import { Buffer } from 'node:buffer'
import { http } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { lgtmOnPullRequest } from '../../src/plugins/lgtmBinding'
import { ownersLabel } from '../../src/plugins/ownersLabel'
import { requireMatchingLabel } from '../../src/plugins/requireMatchingLabel'
import issuesLabeledEvent from '../fixtures/issues/issuesLabeledEvent.json'
import labelFileContents from '../fixtures/labels/labelFileContentsResp.json'
import pullReqOpenedEvent from '../fixtures/pullReq/pullReqOpenedEvent.json'
import * as utils from '../testUtils'
import { prHandlers } from '../utils/ownersFixtures'

const server = setupServer()
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
beforeEach(() => utils.setupActionsEnv())
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

const repo = `${utils.api}/repos/Codertocat/Hello-World`
const headSha = pullReqOpenedEvent.pull_request.head.sha

describe('lgtmOnPullRequest without a sender', () => {
  it('binds the label as "unknown" and omits the target url when the payload carries neither', async () => {
    server.use(...utils.noOrgOrRepoConfigExcept())
    const status = new utils.ObserveRequest()
    server.use(http.post(`${repo}/statuses/${headSha}`, utils.mockResponse(201, {}, status)))

    const { html_url: _url, ...pullRequest } = pullReqOpenedEvent.pull_request
    const payload = { ...pullReqOpenedEvent, action: 'labeled', label: { name: 'lgtm' }, pull_request: pullRequest } as Record<string, unknown>
    delete payload.sender

    await expect(lgtmOnPullRequest(new utils.MockContext(payload))).resolves.toBeUndefined()

    await expect(status.called()).resolves.toBe('called')
    expect(await status.body()).toEqual({
      state: 'success',
      context: 'prow/lgtm',
      description: `lgtm by unknown at ${headSha.slice(0, 7)}`,
    })
  })
})

describe('ownersLabel when the repository labels cannot be listed', () => {
  it('fails with the listing error', async () => {
    server.use(
      ...prHandlers({ 'sdk/OWNERS': 'labels:\n- area/sdk\n' }, ['sdk/x.go']),
      http.get(`${repo}/issues/1`, utils.mockResponse(200, { labels: [] })),
      http.get(`${repo}/labels`, utils.mockResponse(500, { message: 'boom' })),
    )

    await expect(ownersLabel(new utils.MockContext({ ...structuredClone(pullReqOpenedEvent), action: 'opened' })))
      .rejects
      .toThrow(/^could not list the repository labels: .*boom/)
  })
})

describe('requireMatchingLabel error paths', () => {
  const project = 'Codertocat/.project:prow.yaml'

  function serveKindRule() {
    const file = structuredClone(labelFileContents)
    file.content = Buffer.from(
      'require_matching_label:\n  - { regexp: "^kind/", missing_label: needs-kind, missing_comment: "Please add a kind label." }\n',
    ).toString('base64')
    server.use(
      http.get(utils.contentsUrl(project), utils.mockResponse(200, file)),
      ...utils.noOrgOrRepoConfigExcept(project),
    )
  }

  it('fails without an issue or pull request in the payload', async () => {
    await expect(requireMatchingLabel(new utils.MockContext({ action: 'opened' }))).rejects.toThrow(
      'github context payload missing issue or pull request',
    )
  })

  it('names the rule when the comments cannot be listed', async () => {
    serveKindRule()
    const payload = structuredClone(issuesLabeledEvent)
    payload.action = 'opened'
    payload.issue.labels = []
    server.use(
      http.get(`${repo}/issues/1`, utils.mockResponse(200, { labels: [] })),
      utils.repoHasLabels(['needs-kind']),
      http.post(`${repo}/issues/1/labels`, utils.mockResponse(200, [])),
      http.get(`${repo}/issues/1/comments`, utils.mockResponse(500, { message: 'boom' })),
    )

    await expect(requireMatchingLabel(new utils.MockContext(payload))).rejects.toThrow(
      /^require-matching-label needs-kind: could not list comments: .*boom/,
    )
  })

  it('treats a bot comment without a body as unmarked and deletes nothing', async () => {
    serveKindRule()
    const payload = structuredClone(issuesLabeledEvent)
    payload.action = 'labeled'
    payload.label = { ...payload.label, name: 'kind/bug' }
    const deleteComment = new utils.ObserveRequest()
    server.use(
      http.get(`${repo}/issues/1`, utils.mockResponse(200, { labels: [{ name: 'kind/bug' }, { name: 'needs-kind' }] })),
      utils.repoHasLabels(['needs-kind', 'kind/bug']),
      http.delete(`${repo}/issues/1/labels/:name`, utils.mockResponse(200, [])),
      http.get(`${repo}/issues/1/comments`, utils.mockResponse(200, [{ id: 11, body: null, user: { login: 'github-actions[bot]', type: 'Bot' } }])),
      http.delete(`${repo}/issues/comments/:id`, utils.mockResponse(204, null, deleteComment)),
    )

    await expect(requireMatchingLabel(new utils.MockContext(payload))).resolves.toBeUndefined()

    await expect(deleteComment.notCalled()).resolves.toBe('not called')
  })
})
