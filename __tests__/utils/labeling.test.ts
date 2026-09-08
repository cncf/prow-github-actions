import * as core from '@actions/core'
import { http } from 'msw'

import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { handleIssueComment } from '../../src/issueComment/handleIssueComment'
import issueCommentEvent from '../fixtures/issues/issueCommentEvent.json'

import labelFileContents from '../fixtures/labels/labelFileContentsResp.json'
import malformedFileContents from '../fixtures/labels/labelFileMalformedResponse.json'
import * as utils from '../testUtils'

const server = setupServer()
beforeAll(() =>
  server.listen({
    onUnhandledRequest: 'warn',
  }),
)
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

describe('utils labeling', () => {
  beforeEach(() => {
    utils.setupActionsEnv('/area')
  })

  it('can read from both .yaml and .yml label files', async () => {
    issueCommentEvent.comment.body = '/area important'
    const commentContext = new utils.MockContext(issueCommentEvent)

    const observeReq = new utils.ObserveRequest()
    server.use(
      http.post(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1/labels`,
        utils.mockResponse(200, null, observeReq),
      ),
    )

    server.use(
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/contents/.prowlabels.yml`,
        utils.mockResponse(200, labelFileContents),
      ),
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/contents/.prowlabels.yaml`,
        utils.mockResponse(404),
      ),
    )

    await handleIssueComment(commentContext)
    await observeReq.called()
    expect(await observeReq.body()).toMatchObject({
      labels: ['area/important'],
    })
  })

  it('can error correctly on malformed label.yaml', async () => {
    const spy = vi.spyOn(core, 'setFailed')

    issueCommentEvent.comment.body = '/area important'
    const commentContext = new utils.MockContext(issueCommentEvent)

    server.use(
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/contents/.prowlabels.yml`,
        utils.mockResponse(200, malformedFileContents),
      ),
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/contents/.prowlabels.yaml`,
        utils.mockResponse(404),
      ),
    )

    await handleIssueComment(commentContext)

    expect(spy).toHaveBeenCalled()
  })
})
