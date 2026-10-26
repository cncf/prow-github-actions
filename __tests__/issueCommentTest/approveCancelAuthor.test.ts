import { Buffer } from 'node:buffer'
import { http } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { handleIssueComment } from '../../src/issueComment/handleIssueComment'
import issueCommentEventAssignFixture from '../fixtures/issues/assign/issueCommentEventAssign.json'
import pullReqListReviews from '../fixtures/pullReq/pullReqListReviews.json'
import * as utils from '../testUtils'

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
  let issueCommentEventAssign: typeof issueCommentEventAssignFixture

  beforeEach(() => {
    utils.setupActionsEnv('/approve')
    issueCommentEventAssign = structuredClone(issueCommentEventAssignFixture)
    const owners = Buffer.from('approvers:\n- some-user\n').toString('base64')
    server.use(
      http.get(`${repo}/contents/OWNERS`, utils.mockResponse(200, { type: 'file', encoding: 'base64', size: 4096, name: 'OWNERS', path: 'OWNERS', content: owners })),
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
})
