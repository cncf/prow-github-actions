import * as core from '@actions/core'
import { http } from 'msw'
import { setupServer } from 'msw/node'

import { handleIssueComment } from '../../src/issueComment/handleIssueComment'
import issuePayload from '../fixtures/issues/issue.json'

import issueCommentEvent from '../fixtures/issues/issueCommentEvent.json'
import * as utils from '../testUtils'

const server = setupServer()
beforeAll(() =>
  server.listen({
    onUnhandledRequest: 'warn',
  }),
)
afterEach(() => {
  server.resetHandlers()
  jest.restoreAllMocks()
})
afterAll(() => server.close())

describe('hold', () => {
  beforeEach(() => {
    utils.setupActionsEnv('/hold')
  })

  it('labels the issue with the hold label', async () => {
    issueCommentEvent.comment.body = '/hold'
    const commentContext = new utils.MockContext(issueCommentEvent)

    const observeReq = new utils.ObserveRequest()
    server.use(
      http.post(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1/labels`,
        utils.mockResponse(200, null, observeReq),
      ),
    )

    await handleIssueComment(commentContext)
    await observeReq.called()
    expect(await observeReq.body()).toMatchObject({
      labels: ['hold'],
    })
  })

  it('removes the hold label with /hold cancel', async () => {
    issueCommentEvent.comment.body = '/hold cancel'
    const commentContext = new utils.MockContext(issueCommentEvent)

    issuePayload.labels.push({
      id: 1,
      node_id: '123',
      url: 'https://api.github.com/repos/octocat/Hello-World/labels/lgtm',
      name: 'hold',
      description: 'looks good to me',
      color: 'f29513',
      default: true,
    })

    const observeReqDelete = new utils.ObserveRequest()
    const observeReqGet = new utils.ObserveRequest()
    server.use(
      http.delete(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1/labels/hold`,
        utils.mockResponse(200, null, observeReqDelete),
      ),
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1`,
        utils.mockResponse(200, issuePayload, observeReqGet),
      ),
    )

    await handleIssueComment(commentContext)
    await expect(observeReqDelete.called()).resolves.toBe('called')
    await expect(observeReqGet.called()).resolves.toBe('called')
  })

  it('fails the action when the hold removal fails', async () => {
    issueCommentEvent.comment.body = '/hold cancel'
    const commentContext = new utils.MockContext(issueCommentEvent)

    const payload = structuredClone(issuePayload)
    payload.labels.push({
      id: 2,
      node_id: '456',
      url: 'https://api.github.com/repos/octocat/Hello-World/labels/hold',
      name: 'hold',
      description: '',
      color: 'f29513',
      default: true,
    })

    server.use(
      http.delete(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1/labels/hold`,
        utils.mockResponse(500),
      ),
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1`,
        utils.mockResponse(200, payload),
      ),
    )

    const setFailed = jest.spyOn(core, 'setFailed').mockImplementation(() => {})
    await handleIssueComment(commentContext)
    expect(setFailed).toHaveBeenCalledWith(
      expect.stringContaining('could not remove label hold'),
    )
  })
})
