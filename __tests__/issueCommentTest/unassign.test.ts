import * as core from '@actions/core'
import { http } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { handleIssueComment } from '../../src/issueComment/handleIssueComment'

import issueCommentEventUnassign from '../fixtures/issues/unassign/issueCommentEventUnassign.json'

import issueUnassignedResp from '../fixtures/issues/unassign/issueUnassignedResponse.json'
import * as utils from '../testUtils'

const server = setupServer()
beforeAll(() =>
  server.listen({
    onUnhandledRequest: 'error',
  }),
)
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

describe('/unassign', () => {
  beforeEach(() => {
    utils.setupActionsEnv('/unassign')
  })

  it('handles self unassignment with comment /unassign', async () => {
    const observeReq = new utils.ObserveRequest()
    server.use(
      http.delete(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1/assignees`,
        utils.mockResponse(201, issueUnassignedResp, observeReq),
      ),
    )

    const commentContext = new utils.MockContext(issueCommentEventUnassign)

    await handleIssueComment(commentContext)
    await observeReq.called()
    expect(await observeReq.body()).toMatchObject({
      assignees: ['Codertocat'],
    })
  })

  it('handles unassign another user with /unassign @username', async () => {
    issueCommentEventUnassign.comment.body = '/unassign @some-user'

    server.use(
      http.get(
        `${utils.api}/orgs/Codertocat/members/Codertocat`,
        utils.mockResponse(204),
      ),
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/collaborators/Codertocat`,
        utils.mockResponse(404),
      ),
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1/comments`,
        utils.mockResponse(404),
      ),
    )

    const observeReq = new utils.ObserveRequest()
    server.use(
      http.delete(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1/assignees`,
        utils.mockResponse(201, issueUnassignedResp, observeReq),
      ),
    )

    const commentContext = new utils.MockContext(issueCommentEventUnassign)

    await handleIssueComment(commentContext)
    await observeReq.called()
    expect(await observeReq.body()).toMatchObject({
      assignees: ['some-user'],
    })
  })

  it('handles unassigning another user with /unassign username', async () => {
    issueCommentEventUnassign.comment.body = '/unassign some-user'

    server.use(
      http.get(
        `${utils.api}/orgs/Codertocat/members/Codertocat`,
        utils.mockResponse(204),
      ),
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/collaborators/Codertocat`,
        utils.mockResponse(404),
      ),
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1/comments`,
        utils.mockResponse(404),
      ),
    )

    const observeReq = new utils.ObserveRequest()
    server.use(
      http.delete(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1/assignees`,
        utils.mockResponse(201, issueUnassignedResp, observeReq),
      ),
    )

    const commentContext = new utils.MockContext(issueCommentEventUnassign)

    await handleIssueComment(commentContext)
    await observeReq.called()
    expect(await observeReq.body()).toMatchObject({
      assignees: ['some-user'],
    })
  })

  it('handles unassigning multiple users', async () => {
    issueCommentEventUnassign.comment.body = '/unassign @some-user @other-user'

    server.use(
      http.get(
        `${utils.api}/orgs/Codertocat/members/Codertocat`,
        utils.mockResponse(204),
      ),
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/collaborators/Codertocat`,
        utils.mockResponse(404),
      ),
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1/comments`,
        utils.mockResponse(404),
      ),
    )

    const observeReq = new utils.ObserveRequest()
    server.use(
      http.delete(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1/assignees`,
        utils.mockResponse(201, issueUnassignedResp, observeReq),
      ),
    )

    const commentContext = new utils.MockContext(issueCommentEventUnassign)

    await handleIssueComment(commentContext)
    await observeReq.called()
    expect(await observeReq.body()).toMatchObject({
      assignees: ['some-user', 'other-user'],
    })
  })

  it('handles unassign another user if commenter is org member', async () => {
    issueCommentEventUnassign.comment.body = '/unassign @some-user'

    server.use(
      http.get(
        `${utils.api}/orgs/Codertocat/members/Codertocat`,
        utils.mockResponse(204),
      ),
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/collaborators/Codertocat`,
        utils.mockResponse(404),
      ),
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1/comments`,
        utils.mockResponse(404),
      ),
    )

    const observeReq = new utils.ObserveRequest()
    server.use(
      http.delete(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1/assignees`,
        utils.mockResponse(201, issueUnassignedResp, observeReq),
      ),
    )

    const commentContext = new utils.MockContext(issueCommentEventUnassign)

    await handleIssueComment(commentContext)
    await observeReq.called()
    expect(await observeReq.body()).toMatchObject({
      assignees: ['some-user'],
    })
  })

  it('does not unassign another user when commenter is not authorized', async () => {
    issueCommentEventUnassign.comment.body = '/unassign @some-user'

    server.use(
      http.get(
        `${utils.api}/orgs/Codertocat/members/Codertocat`,
        utils.mockResponse(404),
      ),
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/collaborators/Codertocat`,
        utils.mockResponse(404),
      ),
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1/comments`,
        utils.mockResponse(404),
      ),
    )

    const observeReq = new utils.ObserveRequest()
    server.use(
      http.delete(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1/assignees`,
        utils.mockResponse(201, issueUnassignedResp, observeReq),
      ),
    )

    const commentContext = new utils.MockContext(issueCommentEventUnassign)

    const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})
    await handleIssueComment(commentContext)
    await expect(observeReq.notCalled()).resolves.toBe('not called')
    expect(setFailed).not.toHaveBeenCalled()
  })
})
