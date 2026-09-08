import { http } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { handleIssueComment } from '../../src/issueComment/handleIssueComment'
import issueAssignedResp from '../fixtures/issues/assign/issueAssignedResponse.json'

import issueCommentEventAssign from '../fixtures/issues/assign/issueCommentEventAssign.json'
import issueListComments from '../fixtures/issues/assign/issueListComments.json'
import * as utils from '../testUtils'

const server = setupServer()
beforeAll(() =>
  server.listen({
    onUnhandledRequest: 'error',
  }),
)
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

describe('/assign', () => {
  beforeEach(() => {
    utils.setupActionsEnv('/assign')
  })

  it('handles self assigning with comment /assign', async () => {
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
      http.post(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1/assignees`,
        utils.mockResponse(201, issueAssignedResp, observeReq),
      ),
    )

    const commentContext = new utils.MockContext(issueCommentEventAssign)

    await handleIssueComment(commentContext)
    await observeReq.called()
    expect(await observeReq.body()).toMatchObject({
      assignees: ['Codertocat'],
    })
  })

  it('handles assigning another user with /assign @username', async () => {
    issueCommentEventAssign.comment.body = '/assign @some-user'

    server.use(
      http.get(
        `${utils.api}/orgs/Codertocat/members/some-user`,
        utils.mockResponse(204),
      ),
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/collaborators/some-user`,
        utils.mockResponse(404),
      ),
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1/comments`,
        utils.mockResponse(404),
      ),
    )

    const observeReq = new utils.ObserveRequest()
    server.use(
      http.post(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1/assignees`,
        utils.mockResponse(201, issueAssignedResp, observeReq),
      ),
    )

    const commentContext = new utils.MockContext(issueCommentEventAssign)

    await handleIssueComment(commentContext)
    await observeReq.called()
    expect(await observeReq.body()).toMatchObject({
      assignees: ['some-user'],
    })
  })

  it('handles assigning another user with /assign username', async () => {
    issueCommentEventAssign.comment.body = '/assign some-user'

    server.use(
      http.get(
        `${utils.api}/orgs/Codertocat/members/some-user`,
        utils.mockResponse(204),
      ),
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/collaborators/some-user`,
        utils.mockResponse(404),
      ),
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1/comments`,
        utils.mockResponse(404),
      ),
    )

    const observeReq = new utils.ObserveRequest()
    server.use(
      http.post(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1/assignees`,
        utils.mockResponse(201, issueAssignedResp, observeReq),
      ),
    )

    const commentContext = new utils.MockContext(issueCommentEventAssign)

    await handleIssueComment(commentContext)
    await observeReq.called()
    expect(await observeReq.body()).toMatchObject({
      assignees: ['some-user'],
    })
  })

  it('handles assigning multiple users', async () => {
    issueCommentEventAssign.comment.body = '/assign @some-user @other-user'

    server.use(
      http.get(
        `${utils.api}/orgs/Codertocat/members/some-user`,
        utils.mockResponse(204),
      ),
      http.get(
        `${utils.api}/orgs/Codertocat/members/other-user`,
        utils.mockResponse(204),
      ),
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/collaborators/some-user`,
        utils.mockResponse(404),
      ),
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/collaborators/other-user`,
        utils.mockResponse(404),
      ),
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1/comments`,
        utils.mockResponse(404),
      ),
    )

    const observeReq = new utils.ObserveRequest()
    server.use(
      http.post(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1/assignees`,
        utils.mockResponse(201, issueAssignedResp, observeReq),
      ),
    )

    const commentContext = new utils.MockContext(issueCommentEventAssign)

    await handleIssueComment(commentContext)
    await observeReq.called()
    expect(await observeReq.body()).toMatchObject({
      assignees: ['some-user', 'other-user'],
    })
  })

  it('assigns user if they are an org member', async () => {
    issueCommentEventAssign.comment.body = '/assign @some-user'

    server.use(
      http.get(
        `${utils.api}/orgs/Codertocat/members/some-user`,
        utils.mockResponse(204),
      ),
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/collaborators/some-user`,
        utils.mockResponse(404),
      ),
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1/comments`,
        utils.mockResponse(404),
      ),
    )

    const observeReq = new utils.ObserveRequest()
    server.use(
      http.post(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1/assignees`,
        utils.mockResponse(201, issueAssignedResp, observeReq),
      ),
    )

    const commentContext = new utils.MockContext(issueCommentEventAssign)

    await handleIssueComment(commentContext)
    await observeReq.called()
    expect(await observeReq.body()).toMatchObject({
      assignees: ['some-user'],
    })
  })

  it('assigns user if they are a repo collaborator', async () => {
    issueCommentEventAssign.comment.body = '/assign @some-user'

    server.use(
      http.get(
        `${utils.api}/orgs/Codertocat/members/some-user`,
        utils.mockResponse(404),
      ),
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/collaborators/some-user`,
        utils.mockResponse(204),
      ),
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1/comments`,
        utils.mockResponse(404),
      ),
    )

    const observeReq = new utils.ObserveRequest()
    server.use(
      http.post(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1/assignees`,
        utils.mockResponse(201, issueAssignedResp, observeReq),
      ),
    )

    const commentContext = new utils.MockContext(issueCommentEventAssign)

    await handleIssueComment(commentContext)
    await observeReq.called()
    expect(await observeReq.body()).toMatchObject({
      assignees: ['some-user'],
    })
  })

  it('assigns user if they have previously commented', async () => {
    issueCommentEventAssign.comment.body = '/assign @some-user'

    server.use(
      http.get(
        `${utils.api}/orgs/Codertocat/members/some-user`,
        utils.mockResponse(404),
      ),
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/collaborators/some-user`,
        utils.mockResponse(404),
      ),
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1/comments`,
        utils.mockResponse(200, issueListComments),
      ),
    )

    const observeReq = new utils.ObserveRequest()
    server.use(
      http.post(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1/assignees`,
        utils.mockResponse(201, issueAssignedResp, observeReq),
      ),
    )

    const commentContext = new utils.MockContext(issueCommentEventAssign)

    await handleIssueComment(commentContext)
    await observeReq.called()
    expect(await observeReq.body()).toMatchObject({
      assignees: ['some-user'],
    })
  })
})
