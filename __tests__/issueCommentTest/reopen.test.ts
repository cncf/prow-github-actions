import { http } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { handleIssueComment } from '../../src/issueComment/handleIssueComment'

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

describe('/reopen', () => {
  beforeEach(() => {
    utils.setupActionsEnv('/reopen')
  })

  it('reopens the issue with /reopen', async () => {
    issueCommentEvent.comment.body = '/reopen much better title'

    server.use(
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/collaborators/Codertocat`,
        utils.mockResponse(204),
      ),
    )

    const observeReq = new utils.ObserveRequest()
    server.use(
      http.patch(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1`,
        utils.mockResponse(200, null, observeReq),
      ),
    )

    const commentContext = new utils.MockContext(issueCommentEvent)

    await handleIssueComment(commentContext)
    await observeReq.called()
    expect(await observeReq.body()).toMatchObject({
      state: 'open',
    })
  })

  describe('error', () => {
    it.skip('reply with error message cannot open', () => {
      // TODO
    })
  })
})
