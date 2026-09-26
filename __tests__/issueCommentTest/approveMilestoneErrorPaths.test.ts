import * as core from '@actions/core'
import { http } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { approve } from '../../src/issueComment/approve'
import { milestone } from '../../src/issueComment/milestone'
import * as auth from '../../src/utils/auth'

import issueCommentEvent from '../fixtures/issues/issueCommentEvent.json'
import pullReqListReviews from '../fixtures/pullReq/pullReqListReviews.json'
import * as utils from '../testUtils'

// the auth helpers swallow HTTP failures themselves, so the handlers' own
// "could not check auth" branches are only reachable when the helper rejects
vi.mock('../../src/utils/auth', { spy: true })

const server = setupServer()
beforeAll(() =>
  server.listen({
    onUnhandledRequest: 'error',
  }),
)
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

const issue = `${utils.api}/repos/Codertocat/Hello-World/issues/1`
const pull = `${utils.api}/repos/Codertocat/Hello-World/pulls/1`
const forbidden = { message: 'Resource not accessible by integration' }

// the fixture is a plain issue comment, so /approve takes the legacy review path
function comment(body: string) {
  const payload = structuredClone(issueCommentEvent)
  payload.comment.body = body
  return new utils.MockContext(payload)
}

function commentWithoutIssue(body: string) {
  const context = comment(body)
  delete context.payload.issue
  return context
}

function failing(method: 'get' | 'post' | 'put', url: string) {
  server.use(http[method](url, utils.mockResponse(403, forbidden)))
}

beforeEach(() => {
  utils.setupActionsEnv()
})

describe('/approve error paths', () => {
  it('throws when the payload has no issue number', async () => {
    await expect(approve(commentWithoutIssue('/approve'))).rejects.toThrow(
      /missing issue number/,
    )
  })

  it('wraps a failed review creation', async () => {
    vi.mocked(auth.assertAuthorizedByOwnersOrMembership).mockResolvedValueOnce()
    failing('post', `${pull}/reviews`)

    await expect(approve(comment('/approve'))).rejects.toThrow(/could not create review/)
  })

  it('still fails with the auth error when the refusal comment cannot be posted', async () => {
    const cause = new Error('not an approver')
    vi.mocked(auth.assertAuthorizedByOwnersOrMembership).mockRejectedValueOnce(cause)
    failing('post', `${issue}/comments`)
    const error = vi.spyOn(core, 'error').mockImplementation(() => {})

    await expect(approve(comment('/approve'))).rejects.toBe(cause)
    expect(error).toHaveBeenCalledWith(
      expect.stringContaining('Could not comment with an auth error'),
    )
  })

  it('wraps a failed review listing on cancel', async () => {
    vi.mocked(auth.assertAuthorizedByOwnersOrMembership).mockResolvedValueOnce()
    failing('get', `${pull}/reviews`)

    await expect(approve(comment('/approve cancel'))).rejects.toThrow(
      /could not remove latest review: Error: could not list reviews for PR 1/,
    )
  })

  it('wraps a failed review dismissal on cancel', async () => {
    vi.mocked(auth.assertAuthorizedByOwnersOrMembership).mockResolvedValueOnce()
    server.use(http.get(`${pull}/reviews`, utils.mockResponse(200, pullReqListReviews)))
    failing('put', `${pull}/reviews/80/dismissals`)

    await expect(approve(comment('/remove-approve'))).rejects.toThrow(
      /could not remove latest review: Error: could not dismiss review/,
    )
  })
})

describe('/milestone error paths', () => {
  it('throws when the payload has no issue number', async () => {
    await expect(milestone(commentWithoutIssue('/milestone v1'))).rejects.toThrow(
      /missing issue number/,
    )
  })

  it('wraps a failed collaborator check', async () => {
    vi.mocked(auth.checkCollaborator).mockRejectedValueOnce(new Error('auth exploded'))

    await expect(milestone(comment('/milestone v1'))).rejects.toThrow(
      /could not check commenter auth: Error: auth exploded/,
    )
  })
})
