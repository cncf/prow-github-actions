import * as core from '@actions/core'
import { http } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { handleIssueComment } from '../../src/issueComment/handleIssueComment'
import issuePayload from '../fixtures/issues/issue.json'

import issueCommentEvent from '../fixtures/issues/issueCommentEvent.json'
import * as utils from '../testUtils'

const server = setupServer()
beforeAll(() =>
  server.listen({
    onUnhandledRequest: 'error',
  }),
)
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

describe('hold', () => {
  beforeEach(() => {
    utils.setupActionsEnv('/hold')
  })

  it('labels the issue with the hold label', async () => {
    issueCommentEvent.comment.body = '/hold'
    const commentContext = new utils.MockContext(issueCommentEvent)

    const observeReq = new utils.ObserveRequest()
    server.use(
      http.post(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1/labels`,
        utils.mockResponse(200, null, observeReq),
      ),
    )

    await handleIssueComment(commentContext)
    await observeReq.called()
    expect(await observeReq.body()).toMatchObject({
      labels: ['hold'],
    })
  })

  it('removes the hold label with /hold cancel', async () => {
    issueCommentEvent.comment.body = '/hold cancel'
    const commentContext = new utils.MockContext(issueCommentEvent)

    const payload = structuredClone(issuePayload)
    payload.labels.push({
      id: 1,
      node_id: '123',
      url: 'https://api.github.com/repos/octocat/Hello-World/labels/lgtm',
      name: 'hold',
      description: 'looks good to me',
      color: 'f29513',
      default: true,
    })

    const observeReqDelete = new utils.ObserveRequest()
    const observeReqGet = new utils.ObserveRequest()
    server.use(
      http.delete(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1/labels/hold`,
        utils.mockResponse(200, null, observeReqDelete),
      ),
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1`,
        utils.mockResponse(200, payload, observeReqGet),
      ),
    )

    await handleIssueComment(commentContext)
    await expect(observeReqDelete.called()).resolves.toBe('called')
    await expect(observeReqGet.called()).resolves.toBe('called')
  })

  it('does not issue a removal with /hold cancel when hold is absent', async () => {
    issueCommentEvent.comment.body = '/hold cancel'
    const commentContext = new utils.MockContext(issueCommentEvent)

    const observeReqDelete = new utils.ObserveRequest()
    server.use(
      http.delete(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1/labels/hold`,
        utils.mockResponse(200, null, observeReqDelete),
      ),
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1`,
        utils.mockResponse(200, issuePayload),
      ),
    )

    const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})
    await handleIssueComment(commentContext)
    await expect(observeReqDelete.notCalled()).resolves.toBe('not called')
    expect(setFailed).not.toHaveBeenCalled()
  })

  it.each([
    ['/hold\n/hold cancel'],
    ['/hold cancel\n/hold'],
  ])('cancel wins when a comment carries both /hold and /hold cancel: %j', async (body) => {
    issueCommentEvent.comment.body = body
    const commentContext = new utils.MockContext(issueCommentEvent)

    const payload = structuredClone(issuePayload)
    payload.labels.push({ ...payload.labels[0], name: 'hold' })

    const observeReqDelete = new utils.ObserveRequest()
    const observeReqAdd = new utils.ObserveRequest()
    server.use(
      http.delete(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1/labels/hold`,
        utils.mockResponse(200, null, observeReqDelete),
      ),
      http.post(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1/labels`,
        utils.mockResponse(200, null, observeReqAdd),
      ),
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1`,
        utils.mockResponse(200, payload),
      ),
    )

    const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})
    await handleIssueComment(commentContext)
    await expect(observeReqDelete.called()).resolves.toBe('called')
    await expect(observeReqAdd.notCalled()).resolves.toBe('not called')
    expect(setFailed).not.toHaveBeenCalled()
  })

  it.each(['/unhold', '/remove-hold'])('removes the hold label with %s', async (body) => {
    issueCommentEvent.comment.body = body
    const commentContext = new utils.MockContext(issueCommentEvent)

    const payload = structuredClone(issuePayload)
    payload.labels.push({
      id: 2,
      node_id: '456',
      url: 'https://api.github.com/repos/octocat/Hello-World/labels/hold',
      name: 'hold',
      description: '',
      color: 'f29513',
      default: true,
    })

    const observeReqDelete = new utils.ObserveRequest()
    const observeReqAdd = new utils.ObserveRequest()
    server.use(
      http.delete(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1/labels/hold`,
        utils.mockResponse(200, null, observeReqDelete),
      ),
      http.post(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1/labels`,
        utils.mockResponse(200, null, observeReqAdd),
      ),
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1`,
        utils.mockResponse(200, payload),
      ),
    )

    const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})
    await handleIssueComment(commentContext)
    await expect(observeReqDelete.called()).resolves.toBe('called')
    await expect(observeReqAdd.notCalled()).resolves.toBe('not called')
    expect(setFailed).not.toHaveBeenCalled()
  })

  it.each(['/unhold', '/remove-hold'])('does not issue a removal with %s when hold is absent', async (body) => {
    issueCommentEvent.comment.body = body
    const commentContext = new utils.MockContext(issueCommentEvent)

    const observeReqDelete = new utils.ObserveRequest()
    server.use(
      http.delete(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1/labels/hold`,
        utils.mockResponse(200, null, observeReqDelete),
      ),
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1`,
        utils.mockResponse(200, issuePayload),
      ),
    )

    const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})
    await handleIssueComment(commentContext)
    await expect(observeReqDelete.notCalled()).resolves.toBe('not called')
    expect(setFailed).not.toHaveBeenCalled()
  })

  it('removes the hold label when /unhold is the configured command', async () => {
    utils.setupActionsEnv('/unhold')
    issueCommentEvent.comment.body = '/unhold'
    const commentContext = new utils.MockContext(issueCommentEvent)

    const payload = structuredClone(issuePayload)
    payload.labels.push({
      id: 2,
      node_id: '456',
      url: 'https://api.github.com/repos/octocat/Hello-World/labels/hold',
      name: 'hold',
      description: '',
      color: 'f29513',
      default: true,
    })

    const observeReqDelete = new utils.ObserveRequest()
    server.use(
      http.delete(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1/labels/hold`,
        utils.mockResponse(200, null, observeReqDelete),
      ),
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1`,
        utils.mockResponse(200, payload),
      ),
    )

    const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})
    await handleIssueComment(commentContext)
    await expect(observeReqDelete.called()).resolves.toBe('called')
    expect(setFailed).not.toHaveBeenCalled()
  })

  it('fails the action when the hold removal fails', async () => {
    issueCommentEvent.comment.body = '/hold cancel'
    const commentContext = new utils.MockContext(issueCommentEvent)

    const payload = structuredClone(issuePayload)
    payload.labels.push({
      id: 2,
      node_id: '456',
      url: 'https://api.github.com/repos/octocat/Hello-World/labels/hold',
      name: 'hold',
      description: '',
      color: 'f29513',
      default: true,
    })

    server.use(
      http.delete(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1/labels/hold`,
        utils.mockResponse(500),
      ),
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1`,
        utils.mockResponse(200, payload),
      ),
    )

    const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})
    await handleIssueComment(commentContext)
    expect(setFailed).toHaveBeenCalledWith(
      expect.stringContaining('could not remove label hold'),
    )
  })
})
