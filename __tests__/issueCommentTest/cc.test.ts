import { http } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { handleIssueComment } from '../../src/issueComment/handleIssueComment'
import issueListComments from '../fixtures/issues/assign/issueListComments.json'

import issueCommentEvent from '../fixtures/issues/issueCommentEvent.json'
import pullReviewRequested from '../fixtures/pullReq/pullReviewRequested.json'
import * as utils from '../testUtils'

const server = setupServer()
beforeAll(() =>
  server.listen({
    onUnhandledRequest: 'warn',
  }),
)
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

describe('/cc', () => {
  beforeEach(() => {
    utils.setupActionsEnv('/cc')
  })

  it('handles self cc-ing with comment /cc', async () => {
    issueCommentEvent.comment.body = '/cc'

    server.use(
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/collaborators/Codertocat`,
        utils.mockResponse(204),
      ),
    )

    const observeReq = new utils.ObserveRequest()
    server.use(
      http.post(
        `${utils.api}/repos/Codertocat/Hello-World/pulls/1/requested_reviewers`,
        utils.mockResponse(201, pullReviewRequested, observeReq),
      ),
    )

    const commentContext = new utils.MockContext(issueCommentEvent)

    await handleIssueComment(commentContext)
    await observeReq.called()
    expect(await observeReq.body()).toMatchObject({
      reviewers: ['Codertocat'],
    })
  })

  it('handles cc-ing another user with /cc @username', async () => {
    issueCommentEvent.comment.body = '/cc @some-user'
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
        `${utils.api}/repos/Codertocat/Hello-World/pulls/1/requested_reviewers`,
        utils.mockResponse(201, pullReviewRequested, observeReq),
      ),
    )

    const commentContext = new utils.MockContext(issueCommentEvent)

    await handleIssueComment(commentContext)
    await observeReq.called()
    expect(await observeReq.body()).toMatchObject({
      reviewers: ['some-user'],
    })
  })

  it('handles cc-ing another user with /cc username', async () => {
    issueCommentEvent.comment.body = '/cc some-user'

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
        `${utils.api}/repos/Codertocat/Hello-World/pulls/1/requested_reviewers`,
        utils.mockResponse(201, pullReviewRequested, observeReq),
      ),
    )

    const commentContext = new utils.MockContext(issueCommentEvent)

    await handleIssueComment(commentContext)
    await observeReq.called()
    expect(await observeReq.body()).toMatchObject({
      reviewers: ['some-user'],
    })
  })

  it('handles cc-ing multiple users', async () => {
    issueCommentEvent.comment.body = '/cc @some-user @other-user'

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
        `${utils.api}/repos/Codertocat/Hello-World/pulls/1/requested_reviewers`,
        utils.mockResponse(201, pullReviewRequested, observeReq),
      ),
    )

    const commentContext = new utils.MockContext(issueCommentEvent)

    await handleIssueComment(commentContext)
    expect(await observeReq.body()).toMatchObject({
      reviewers: ['some-user', 'other-user'],
    })
  })

  it('ccs user if they are an org member', async () => {
    issueCommentEvent.comment.body = '/cc @some-user'

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
        `${utils.api}/repos/Codertocat/Hello-World/pulls/1/requested_reviewers`,
        utils.mockResponse(201, pullReviewRequested, observeReq),
      ),
    )

    const commentContext = new utils.MockContext(issueCommentEvent)

    await handleIssueComment(commentContext)
    await observeReq.called()
    expect(await observeReq.body()).toMatchObject({
      reviewers: ['some-user'],
    })
  })

  it('assigns user if they are a repo collaborator', async () => {
    issueCommentEvent.comment.body = '/cc @some-user'

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
        `${utils.api}/repos/Codertocat/Hello-World/pulls/1/requested_reviewers`,
        utils.mockResponse(201, pullReviewRequested, observeReq),
      ),
    )

    const commentContext = new utils.MockContext(issueCommentEvent)

    await handleIssueComment(commentContext)
    await observeReq.called()
    expect(await observeReq.body()).toMatchObject({
      reviewers: ['some-user'],
    })
  })

  it('assigns user if they have previously commented', async () => {
    issueCommentEvent.comment.body = '/cc @some-user'

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
        `${utils.api}/repos/Codertocat/Hello-World/pulls/1/requested_reviewers`,
        utils.mockResponse(201, pullReviewRequested, observeReq),
      ),
    )

    const commentContext = new utils.MockContext(issueCommentEvent)

    await handleIssueComment(commentContext)
    await observeReq.called()
    expect(await observeReq.body()).toMatchObject({
      reviewers: ['some-user'],
    })
  })
})
