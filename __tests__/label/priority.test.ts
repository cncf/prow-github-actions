import * as core from '@actions/core'
import { http } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { handleIssueComment } from '../../src/issueComment/handleIssueComment'
import issuePayload from '../fixtures/issues/issue.json'
import issueCommentEvent from '../fixtures/issues/issueCommentEvent.json'

import labelFileContents from '../fixtures/labels/labelFileContentsResp.json'
import * as utils from '../testUtils'

const server = setupServer()
beforeAll(() =>
  server.listen({
    onUnhandledRequest: 'error',
  }),
)
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

describe('priority', () => {
  beforeEach(() => {
    utils.setupActionsEnv('/priority')
  })

  it('labels the issue with the priority label', async () => {
    issueCommentEvent.comment.body = '/priority low'
    const commentContext = new utils.MockContext(issueCommentEvent)

    const observeReq = new utils.ObserveRequest()
    server.use(
      http.post(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1/labels`,
        utils.mockResponse(200, null, observeReq),
      ),
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1`,
        utils.mockResponse(200, issuePayload),
      ),
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/contents/.prowlabels.yaml`,
        utils.mockResponse(200, labelFileContents),
      ),
    )

    await handleIssueComment(commentContext)
    await observeReq.called()
    expect(await observeReq.body()).toMatchObject({
      labels: ['priority/low'],
    })
  })

  it('handles multiple priority labels', async () => {
    issueCommentEvent.comment.body = '/priority low high'
    const commentContext = new utils.MockContext(issueCommentEvent)

    const observeReq = new utils.ObserveRequest()
    server.use(
      http.post(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1/labels`,
        utils.mockResponse(200, null, observeReq),
      ),
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1`,
        utils.mockResponse(200, issuePayload),
      ),
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/contents/.prowlabels.yaml`,
        utils.mockResponse(200, labelFileContents),
      ),
    )

    await handleIssueComment(commentContext)
    await observeReq.called()
    expect(await observeReq.body()).toMatchObject({
      labels: ['priority/low', 'priority/high'],
    })
  })

  it('only adds priority labels for files in .prowlabels.yaml', async () => {
    issueCommentEvent.comment.body = '/priority low mid high'
    const commentContext = new utils.MockContext(issueCommentEvent)

    const observeReq = new utils.ObserveRequest()
    server.use(
      http.post(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1/labels`,
        utils.mockResponse(200, null, observeReq),
      ),
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1`,
        utils.mockResponse(200, issuePayload),
      ),
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/contents/.prowlabels.yaml`,
        utils.mockResponse(200, labelFileContents),
      ),
    )

    await handleIssueComment(commentContext)
    await observeReq.called()
    expect(await observeReq.body()).toMatchObject({
      labels: ['priority/low', 'priority/high'],
    })
  })

  it('replaces an existing priority label with the new one', async () => {
    issueCommentEvent.comment.body = '/priority high'
    const commentContext = new utils.MockContext(issueCommentEvent)

    const payload = structuredClone(issuePayload)
    payload.labels.push({
      id: 3,
      node_id: '789',
      url: 'https://api.github.com/repos/octocat/Hello-World/labels/priority/low',
      name: 'priority/low',
      description: '',
      color: 'f29513',
      default: true,
    })

    const observeReqDelete = new utils.ObserveRequest()
    const observeReqPost = new utils.ObserveRequest()
    server.use(
      http.delete(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1/labels/priority%2Flow`,
        utils.mockResponse(200, null, observeReqDelete),
      ),
      http.post(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1/labels`,
        utils.mockResponse(200, null, observeReqPost),
      ),
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1`,
        utils.mockResponse(200, payload),
      ),
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/contents/.prowlabels.yaml`,
        utils.mockResponse(200, labelFileContents),
      ),
    )

    await handleIssueComment(commentContext)
    await expect(observeReqDelete.called()).resolves.toBe('called')
    await observeReqPost.called()
    expect(await observeReqPost.body()).toMatchObject({
      labels: ['priority/high'],
    })
  })

  it('fails when no priority argument is in .prowlabels.yaml', async () => {
    issueCommentEvent.comment.body = '/priority not-a-real-label'
    const commentContext = new utils.MockContext(issueCommentEvent)

    const observeReq = new utils.ObserveRequest()
    server.use(
      http.post(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1/labels`,
        utils.mockResponse(200, null, observeReq),
      ),
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/contents/.prowlabels.yaml`,
        utils.mockResponse(200, labelFileContents),
      ),
    )

    const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})
    await handleIssueComment(commentContext)
    await expect(observeReq.notCalled()).resolves.toBe('not called')
    expect(setFailed).toHaveBeenCalledWith(
      expect.stringContaining('priority: command args missing from body'),
    )
  })
})
