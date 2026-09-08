import { Buffer } from 'node:buffer'
import { http } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { handleIssueComment } from '../../src/issueComment/handleIssueComment'

import issueCommentEventAssign from '../fixtures/issues/assign/issueCommentEventAssign.json'

import pullReqListReviews from '../fixtures/pullReq/pullReqListReviews.json'
import * as utils from '../testUtils'

const server = setupServer()
beforeAll(() =>
  server.listen({
    onUnhandledRequest: 'error',
  }),
)
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

describe('/approve', () => {
  beforeEach(() => {
    utils.setupActionsEnv('/approve')
  })

  it('fails if commenter is not an approver in OWNERS', async () => {
    const owners = Buffer.from(
      `
reviewers:
- Codertocat
    `,
    ).toString('base64')

    const contentResponse = {
      type: 'file',
      encoding: 'base64',
      size: 4096,
      name: 'OWNERS',
      path: 'OWNERS',
      content: owners,
    }

    server.use(
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/contents/OWNERS`,
        utils.mockResponse(200, contentResponse),
      ),
    )
    const wantErr = `Codertocat is not included in the approvers role in the OWNERS file`

    // Mock the reply that the user is not authorized
    const observeReq = new utils.ObserveRequest()
    server.use(
      http.post(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1/comments`,
        utils.mockResponse(200, null, observeReq),
      ),
    )

    issueCommentEventAssign.comment.body = '/approve'
    const commentContext = new utils.MockContext(issueCommentEventAssign)

    await handleIssueComment(commentContext)
    await observeReq.called()
    expect(await observeReq.body().then(body => body.body)).toContain(wantErr)
  })

  it('fails if commenter is not an org member or collaborator', async () => {
    const wantErr = `Codertocat is not a org member or collaborator`

    // Mock the reply that the user is not authorized
    const observeReq = new utils.ObserveRequest()
    server.use(
      http.post(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1/comments`,
        utils.mockResponse(200, null, observeReq),
      ),
    )

    server.use(
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/contents/OWNERS`,
        utils.mockResponse(404),
      ),
      http.get(
        `${utils.api}/orgs/Codertocat/members/Codertocat`,
        utils.mockResponse(404),
      ),
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/collaborators/Codertocat`,
        utils.mockResponse(404),
      ),
    )

    issueCommentEventAssign.comment.body = '/approve'
    const commentContext = new utils.MockContext(issueCommentEventAssign)

    await handleIssueComment(commentContext)
    await observeReq.called()
    expect(await observeReq.body().then(body => body.body)).toContain(wantErr)
  })

  it('approves if commenter is an approver in OWNERS', async () => {
    const owners = Buffer.from(
      `
    approvers:
    - Codertocat
        `,
    ).toString('base64')

    const contentResponse = {
      type: 'file',
      encoding: 'base64',
      size: 4096,
      name: 'OWNERS',
      path: 'OWNERS',
      content: owners,
    }
    server.use(
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/contents/OWNERS`,
        utils.mockResponse(200, contentResponse),
      ),
    )

    const observeReq = new utils.ObserveRequest()
    server.use(
      http.post(
        `${utils.api}/repos/Codertocat/Hello-World/pulls/1/reviews`,
        utils.mockResponse(200, null, observeReq),
      ),
    )

    issueCommentEventAssign.comment.body = '/approve'
    const commentContext = new utils.MockContext(issueCommentEventAssign)

    await handleIssueComment(commentContext)
    await observeReq.called()
    expect(await observeReq.body()).toMatchObject({
      event: 'APPROVE',
    })
  })

  it('approves if commenter is an org member', async () => {
    server.use(
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/contents/OWNERS`,
        utils.mockResponse(404),
      ),
      http.get(
        `${utils.api}/orgs/Codertocat/members/Codertocat`,
        utils.mockResponse(204),
      ),
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/collaborators/Codertocat`,
        utils.mockResponse(404),
      ),
    )

    const observeReq = new utils.ObserveRequest()
    server.use(
      http.post(
        `${utils.api}/repos/Codertocat/Hello-World/pulls/1/reviews`,
        utils.mockResponse(200, null, observeReq),
      ),
    )

    issueCommentEventAssign.comment.body = '/approve'
    const commentContext = new utils.MockContext(issueCommentEventAssign)

    await handleIssueComment(commentContext)
    await observeReq.called()
    expect(await observeReq.body()).toMatchObject({
      event: 'APPROVE',
    })
  })

  it('removes approval with the /approve cancel command if approver in OWNERS file', async () => {
    const owners = Buffer.from(
      `
    approvers:
    - some-user
    `,
    ).toString('base64')

    const contentResponse = {
      type: 'file',
      encoding: 'base64',
      size: 4096,
      name: 'OWNERS',
      path: 'OWNERS',
      content: owners,
    }
    server.use(
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/contents/OWNERS`,
        utils.mockResponse(200, contentResponse),
      ),
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/pulls/1/reviews`,
        utils.mockResponse(200, pullReqListReviews),
      ),
    )

    const observeReq = new utils.ObserveRequest()
    server.use(
      http.put(
        `${utils.api}/repos/Codertocat/Hello-World/pulls/1/reviews/80/dismissals`,
        utils.mockResponse(200, null, observeReq),
      ),
    )

    issueCommentEventAssign.comment.body = '/approve cancel'
    issueCommentEventAssign.comment.user.login = 'some-user'
    const commentContext = new utils.MockContext(issueCommentEventAssign)

    await handleIssueComment(commentContext)
    await observeReq.called()
    expect(await observeReq.body()).toMatchObject({
      message: `Canceled through prow-github-actions by @some-user`,
    })
  })

  it('removes approval with the /approve cancel command if commenter is collaborator', async () => {
    server.use(
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/contents/OWNERS`,
        utils.mockResponse(404),
      ),
      http.get(
        `${utils.api}/orgs/Codertocat/members/some-user`,
        utils.mockResponse(404),
      ),
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/collaborators/some-user`,
        utils.mockResponse(204),
      ),
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/pulls/1/reviews`,
        utils.mockResponse(200, pullReqListReviews),
      ),
    )

    const observeReq = new utils.ObserveRequest()
    server.use(
      http.put(
        `${utils.api}/repos/Codertocat/Hello-World/pulls/1/reviews/80/dismissals`,
        utils.mockResponse(200, null, observeReq),
      ),
    )

    issueCommentEventAssign.comment.body = '/approve cancel'
    issueCommentEventAssign.comment.user.login = 'some-user'
    const commentContext = new utils.MockContext(issueCommentEventAssign)

    await handleIssueComment(commentContext)
    await observeReq.called()
    expect(await observeReq.body()).toMatchObject({
      message: `Canceled through prow-github-actions by @some-user`,
    })
  })
})
