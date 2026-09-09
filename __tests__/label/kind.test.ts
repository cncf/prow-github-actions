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

function issueWithLabels(...names: string[]) {
  const payload = structuredClone(issuePayload)
  for (const name of names) {
    payload.labels.push({ ...payload.labels[0], name })
  }
  return payload
}

describe('kind', () => {
  beforeEach(() => {
    utils.setupActionsEnv('/kind')
  })

  it('labels the issue with the kind label', async () => {
    issueCommentEvent.comment.body = '/kind cleanup'
    const commentContext = new utils.MockContext(issueCommentEvent)

    const observeReq = new utils.ObserveRequest()
    server.use(
      http.post(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1/labels`,
        utils.mockResponse(200, null, observeReq),
      ),
    )

    server.use(
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/contents/.prowlabels.yaml`,
        utils.mockResponse(200, labelFileContents),
      ),
    )

    await handleIssueComment(commentContext)
    await observeReq.called()
    expect(await observeReq.body()).toMatchObject({
      labels: ['kind/cleanup'],
    })
  })

  it('handles multiple kind labels', async () => {
    issueCommentEvent.comment.body = '/kind cleanup failing-test'
    const commentContext = new utils.MockContext(issueCommentEvent)

    const observeReq = new utils.ObserveRequest()
    server.use(
      http.post(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1/labels`,
        utils.mockResponse(200, null, observeReq),
      ),
    )

    server.use(
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/contents/.prowlabels.yaml`,
        utils.mockResponse(200, labelFileContents),
      ),
    )

    await handleIssueComment(commentContext)
    await observeReq.called()
    expect(await observeReq.body()).toMatchObject({
      labels: ['kind/cleanup', 'kind/failing-test'],
    })
  })

  it('only adds kind labels for files in .prowlabels.yaml', async () => {
    issueCommentEvent.comment.body = '/kind cleanup bad failing-test'
    const commentContext = new utils.MockContext(issueCommentEvent)

    const observeReq = new utils.ObserveRequest()
    server.use(
      http.post(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1/labels`,
        utils.mockResponse(200, null, observeReq),
      ),
    )

    server.use(
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/contents/.prowlabels.yaml`,
        utils.mockResponse(200, labelFileContents),
      ),
    )

    await handleIssueComment(commentContext)
    await observeReq.called()
    expect(await observeReq.body()).toMatchObject({
      labels: ['kind/cleanup', 'kind/failing-test'],
    })
  })

  it('fails when no kind argument is in .prowlabels.yaml', async () => {
    issueCommentEvent.comment.body = '/kind not-a-real-label'
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
      expect.stringContaining('kind: command args missing from body'),
    )
  })

  it('removes a kind label with /remove-kind', async () => {
    issueCommentEvent.comment.body = '/remove-kind cleanup'
    const commentContext = new utils.MockContext(issueCommentEvent)

    const observeDelete = new utils.ObserveRequest()
    const observePost = new utils.ObserveRequest()
    server.use(
      http.delete(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1/labels/kind%2Fcleanup`,
        utils.mockResponse(200, null, observeDelete),
      ),
      http.post(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1/labels`,
        utils.mockResponse(200, null, observePost),
      ),
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1`,
        utils.mockResponse(200, issueWithLabels('kind/cleanup')),
      ),
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/contents/.prowlabels.yaml`,
        utils.mockResponse(200, labelFileContents),
      ),
    )

    const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})
    await handleIssueComment(commentContext)
    await expect(observeDelete.called()).resolves.toBe('called')
    await expect(observePost.notCalled()).resolves.toBe('not called')
    expect(setFailed).not.toHaveBeenCalled()
  })

  it('fails /remove-kind for a value not in .prowlabels.yaml', async () => {
    issueCommentEvent.comment.body = '/remove-kind not-a-real-label'
    const commentContext = new utils.MockContext(issueCommentEvent)

    const observeDelete = new utils.ObserveRequest()
    server.use(
      http.delete(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1/labels/kind%2Fnot-a-real-label`,
        utils.mockResponse(200, null, observeDelete),
      ),
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1`,
        utils.mockResponse(200, issueWithLabels('kind/not-a-real-label')),
      ),
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/contents/.prowlabels.yaml`,
        utils.mockResponse(200, labelFileContents),
      ),
    )

    const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})
    await handleIssueComment(commentContext)
    await expect(observeDelete.notCalled()).resolves.toBe('not called')
    expect(setFailed).toHaveBeenCalledWith(
      expect.stringContaining('remove-kind: command args missing from body'),
    )
  })

  it('does not call the api when the kind label is not on the issue', async () => {
    issueCommentEvent.comment.body = '/remove-kind cleanup'
    const commentContext = new utils.MockContext(issueCommentEvent)

    const observeDelete = new utils.ObserveRequest()
    server.use(
      http.delete(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1/labels/kind%2Fcleanup`,
        utils.mockResponse(200, null, observeDelete),
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

    const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})
    await handleIssueComment(commentContext)
    await expect(observeDelete.notCalled()).resolves.toBe('not called')
    expect(setFailed).not.toHaveBeenCalled()
  })

  it('fails the action when the /remove-kind request fails', async () => {
    issueCommentEvent.comment.body = '/remove-kind cleanup'
    const commentContext = new utils.MockContext(issueCommentEvent)

    server.use(
      http.delete(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1/labels/kind%2Fcleanup`,
        utils.mockResponse(500),
      ),
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1`,
        utils.mockResponse(200, issueWithLabels('kind/cleanup')),
      ),
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/contents/.prowlabels.yaml`,
        utils.mockResponse(200, labelFileContents),
      ),
    )

    const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})
    await handleIssueComment(commentContext)
    expect(setFailed).toHaveBeenCalledWith(
      expect.stringContaining('could not remove label kind/cleanup'),
    )
  })

  it('handles /kind and /remove-kind in the same comment', async () => {
    issueCommentEvent.comment.body = '/kind failing-test\n/remove-kind cleanup'
    const commentContext = new utils.MockContext(issueCommentEvent)

    const observeDelete = new utils.ObserveRequest()
    const observePost = new utils.ObserveRequest()
    server.use(
      http.delete(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1/labels/kind%2Fcleanup`,
        utils.mockResponse(200, null, observeDelete),
      ),
      http.post(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1/labels`,
        utils.mockResponse(200, null, observePost),
      ),
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1`,
        utils.mockResponse(200, issueWithLabels('kind/cleanup')),
      ),
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/contents/.prowlabels.yaml`,
        utils.mockResponse(200, labelFileContents),
      ),
    )

    const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})
    await handleIssueComment(commentContext)
    await expect(observeDelete.called()).resolves.toBe('called')
    await observePost.called()
    expect(await observePost.body()).toMatchObject({
      labels: ['kind/failing-test'],
    })
    expect(setFailed).not.toHaveBeenCalled()
  })
})
