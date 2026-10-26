import * as core from '@actions/core'
import { http } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { handleIssueComment } from '../../src/issueComment/handleIssueComment'
import issueCommentEvent from '../fixtures/issues/issueCommentEvent.json'
import * as utils from '../testUtils'

const server = setupServer()
beforeAll(() => server.listen(utils.failOnUnhandledRequest))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

const repo = `${utils.api}/repos/Codertocat/Hello-World`

describe('/milestone: the not-found error lists every open milestone', () => {
  beforeEach(() => {
    utils.setupActionsEnv('/milestone')
  })

  it('separates the available titles with a comma and a space, in the order the API returned them', async () => {
    issueCommentEvent.comment.body = '/milestone v3'

    const observeReq = new utils.ObserveRequest()
    server.use(
      http.get(`${repo}/milestones`, utils.mockResponse(200, [
        { number: 1, title: 'v1' },
        { number: 2, title: 'v2' },
        { number: 3, title: 'backlog' },
      ])),
      http.get(`${repo}/collaborators/Codertocat`, utils.mockResponse(204)),
      http.patch(`${repo}/issues/1`, utils.mockResponse(200, null, observeReq)),
    )

    const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})
    await handleIssueComment(new utils.MockContext(issueCommentEvent))

    await expect(observeReq.notCalled()).resolves.toBe('not called')
    expect(setFailed).toHaveBeenCalledTimes(1)
    expect(setFailed).toHaveBeenCalledWith(
      expect.stringContaining('milestone "v3" not found. Available milestones: v1, v2, backlog'),
    )
  })
})
