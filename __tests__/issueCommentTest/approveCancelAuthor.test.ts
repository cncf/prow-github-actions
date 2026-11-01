import { http } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { handleIssueComment } from '../../src/issueComment/handleIssueComment'
import issueCommentEventAssignFixture from '../fixtures/issues/assign/issueCommentEventAssign.json'
import pullReqListReviews from '../fixtures/pullReq/pullReqListReviews.json'
import * as utils from '../testUtils'
import { prHandlers } from '../utils/ownersFixtures'

const server = setupServer(utils.noMergeQueue)
utils.failTestOnUnhandledRequests(server)
beforeAll(() => server.listen(utils.failOnUnhandledRequest))
beforeEach(() => server.use(...utils.noOrgOrRepoConfigExcept(), utils.defaultBranchTree()))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

const repo = `${utils.api}/repos/Codertocat/Hello-World`

// Pins the author check of `cancel` (src/issueComment/approve.ts): /approve
// cancel dismisses the bot's own latest APPROVED review, not a later approval
// left by a human reviewer. The fixture list carries only the bot's review,
// so approve.test.ts cannot tell the two apart.
describe('/approve cancel with a human approval after the bot review', () => {
  let issueCommentEventAssign: typeof issueCommentEventAssignFixture & { issue: { pull_request: { url: string } } }

  beforeEach(() => {
    utils.setupActionsEnv('/approve')
    const fixture = structuredClone(issueCommentEventAssignFixture)
    issueCommentEventAssign = { ...fixture, issue: { ...fixture.issue, pull_request: { url: `${repo}/pulls/1` } } }
    // a pull request without OWNERS files: the legacy path authorizes an org member
    server.use(
      ...prHandlers({}, ['x.go']),
      http.get(`${utils.api}/orgs/Codertocat/members/some-user`, utils.mockResponse(204)),
      http.get(`${repo}/collaborators/some-user`, utils.mockResponse(404)),
    )
  })

  it('dismisses the bot review and leaves the human approval in place', async () => {
    const botReview = structuredClone(pullReqListReviews[0])
    const humanReview = { ...structuredClone(pullReqListReviews[0]), id: 81, user: { ...pullReqListReviews[0].user, login: 'octocat', id: 2, type: 'User' } }
    expect(botReview.user.login).toBe('github-actions[bot]')
    expect(botReview.state).toBe('APPROVED')
    server.use(http.get(`${repo}/pulls/1/reviews`, utils.mockResponse(200, [botReview, humanReview])))

    const dismissBot = new utils.ObserveRequest()
    const dismissHuman = new utils.ObserveRequest()
    server.use(
      http.put(`${repo}/pulls/1/reviews/80/dismissals`, utils.mockResponse(200, null, dismissBot)),
      http.put(`${repo}/pulls/1/reviews/81/dismissals`, utils.mockResponse(200, null, dismissHuman)),
    )

    issueCommentEventAssign.comment.body = '/approve cancel'
    issueCommentEventAssign.comment.user.login = 'some-user'

    await handleIssueComment(new utils.MockContext(issueCommentEventAssign))

    await expect(dismissBot.called()).resolves.toBe('called')
    await expect(dismissHuman.notCalled()).resolves.toBe('not called')
  })

  // under a GitHub App the token's reviews are authored by `<slug>[bot]`; GraphQL names it without the suffix
  it('dismisses the review of a GitHub App token, not github-actions[bot]\'s', async () => {
    const appReview = { ...structuredClone(pullReqListReviews[0]), id: 82, user: { ...pullReqListReviews[0].user, login: 'my-app[bot]' } }
    server.use(
      utils.mergeQueueGraphql({ enabled: false, viewer: 'my-app' }).handler,
      http.get(`${repo}/pulls/1/reviews`, utils.mockResponse(200, [appReview, structuredClone(pullReqListReviews[0])])),
    )
    const dismissApp = new utils.ObserveRequest()
    const dismissActions = new utils.ObserveRequest()
    server.use(
      http.put(`${repo}/pulls/1/reviews/82/dismissals`, utils.mockResponse(200, null, dismissApp)),
      http.put(`${repo}/pulls/1/reviews/80/dismissals`, utils.mockResponse(200, null, dismissActions)),
    )

    issueCommentEventAssign.comment.body = '/approve cancel'
    issueCommentEventAssign.comment.user.login = 'some-user'
    await handleIssueComment(new utils.MockContext(issueCommentEventAssign))

    await expect(dismissApp.called()).resolves.toBe('called')
    await expect(dismissActions.notCalled()).resolves.toBe('not called')
  })

  it('finds the bot review on the second page of reviews', async () => {
    const humans = Array.from({ length: 100 }, (_, i) => ({ ...structuredClone(pullReqListReviews[0]), id: 1000 + i, user: { ...pullReqListReviews[0].user, login: `human-${i}`, type: 'User' } }))
    server.use(http.get(`${repo}/pulls/1/reviews`, ({ request }) => new URL(request.url).searchParams.get('page') === '2'
      ? Response.json([structuredClone(pullReqListReviews[0])])
      : Response.json(humans, { headers: { Link: `<${repo}/pulls/1/reviews?per_page=100&page=2>; rel="next"` } })))
    const dismissBot = new utils.ObserveRequest()
    server.use(http.put(`${repo}/pulls/1/reviews/80/dismissals`, utils.mockResponse(200, null, dismissBot)))

    issueCommentEventAssign.comment.body = '/approve cancel'
    issueCommentEventAssign.comment.user.login = 'some-user'
    await handleIssueComment(new utils.MockContext(issueCommentEventAssign))

    await expect(dismissBot.called()).resolves.toBe('called')
  })

  it('falls back to github-actions[bot] when the token\'s login cannot be read', async () => {
    server.use(
      utils.mergeQueueGraphql({ enabled: false, viewer: null }).handler,
      http.get(`${repo}/pulls/1/reviews`, utils.mockResponse(200, [structuredClone(pullReqListReviews[0])])),
    )
    const dismissBot = new utils.ObserveRequest()
    server.use(http.put(`${repo}/pulls/1/reviews/80/dismissals`, utils.mockResponse(200, null, dismissBot)))

    issueCommentEventAssign.comment.body = '/approve cancel'
    issueCommentEventAssign.comment.user.login = 'some-user'
    await handleIssueComment(new utils.MockContext(issueCommentEventAssign))

    await expect(dismissBot.called()).resolves.toBe('called')
  })
})
