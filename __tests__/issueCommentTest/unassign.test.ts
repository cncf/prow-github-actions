import * as core from '@actions/core'
import { http } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { handleIssueComment } from '../../src/issueComment/handleIssueComment'

import issueListComments from '../fixtures/issues/assign/issueListComments.json'
import issueCommentEventUnassign from '../fixtures/issues/unassign/issueCommentEventUnassign.json'

import issueUnassignedResp from '../fixtures/issues/unassign/issueUnassignedResponse.json'
import * as utils from '../testUtils'

const server = setupServer()
utils.failTestOnUnhandledRequests(server)
beforeAll(() =>
  server.listen(utils.failOnUnhandledRequest),
)
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

describe('/unassign', () => {
  beforeEach(() => {
    utils.setupActionsEnv('/unassign')
    // the tests below rewrite the shared fixture's comment; start each from the file's own body
    issueCommentEventUnassign.comment.body = '/unassign'
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

  it('does not unassign another user when the commenter has only commented before', async () => {
    issueCommentEventUnassign.comment.body = '/unassign @some-user'

    const observeReq = new utils.ObserveRequest()
    server.use(
      http.get(
        `${utils.api}/orgs/Codertocat/members/Codertocat`,
        utils.mockResponse(404),
      ),
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/collaborators/Codertocat`,
        utils.mockResponse(404),
      ),
      // lists Codertocat's own comment, which used to authorize the commenter
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1/comments`,
        utils.mockResponse(200, issueListComments),
      ),
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

  it('unassigns another user when the commenter is a repo collaborator', async () => {
    issueCommentEventUnassign.comment.body = '/unassign @some-user'

    const observeReq = new utils.ObserveRequest()
    server.use(
      http.get(
        `${utils.api}/orgs/Codertocat/members/Codertocat`,
        utils.mockResponse(404),
      ),
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/collaborators/Codertocat`,
        utils.mockResponse(204),
      ),
      http.delete(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1/assignees`,
        utils.mockResponse(201, issueUnassignedResp, observeReq),
      ),
    )

    const commentContext = new utils.MockContext(issueCommentEventUnassign)

    await handleIssueComment(commentContext)
    await observeReq.called()
    expect(await observeReq.body()).toMatchObject({ assignees: ['some-user'] })
  })
})
