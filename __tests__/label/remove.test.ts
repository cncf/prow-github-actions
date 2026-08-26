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

describe('remove', () => {
  beforeEach(() => {
    utils.setupActionsEnv('/remove')
  })

  it('removes the specified label', async () => {
    issueCommentEvent.comment.body = '/remove some-label'
    const commentContext = new utils.MockContext(issueCommentEvent)

    server.use(
      http.delete(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1/labels/some-label`,
        utils.mockResponse(200),
      ),
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1`,
        utils.mockResponse(200, issuePayload),
      ),
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/collaborators/Codertocat`,
        utils.mockResponse(204),
      ),
    )

    await handleIssueComment(commentContext)
  })

  it('removes multiple labels', async () => {
    issueCommentEvent.comment.body = '/remove some-label some-other-label'
    const commentContext = new utils.MockContext(issueCommentEvent)

    server.use(
      http.delete(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1/labels/some-label`,
        utils.mockResponse(200),
      ),
      http.delete(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1/labels/some-other-label`,
        utils.mockResponse(200),
      ),
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1`,
        utils.mockResponse(200, issuePayload),
      ),
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/collaborators/Codertocat`,
        utils.mockResponse(204),
      ),
    )

    await handleIssueComment(commentContext)
  })

  it('fails if commenter is not collaborator', async () => {
    issueCommentEvent.comment.body = '/remove some-label'
    const commentContext = new utils.MockContext(issueCommentEvent)

    server.use(
      http.delete(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1/labels/some-label`,
        utils.mockResponse(200),
      ),
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1`,
        utils.mockResponse(200, issuePayload),
      ),
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/collaborators/Codertocat`,
        utils.mockResponse(404),
      ),
    )

    const spy = jest.spyOn(core, 'setFailed')
    await handleIssueComment(commentContext)
    expect(spy).toHaveBeenCalled()
  })

  it('fails the action when a label removal fails', async () => {
    issueCommentEvent.comment.body = '/remove some-label'
    const commentContext = new utils.MockContext(issueCommentEvent)

    server.use(
      http.delete(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1/labels/some-label`,
        utils.mockResponse(500),
      ),
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1`,
        utils.mockResponse(200, issuePayload),
      ),
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/collaborators/Codertocat`,
        utils.mockResponse(204),
      ),
    )

    const setFailed = jest.spyOn(core, 'setFailed').mockImplementation(() => {})
    await handleIssueComment(commentContext)
    expect(setFailed).toHaveBeenCalledWith(
      expect.stringContaining('could not remove label some-label'),
    )
  })

  it('ignores a label that is already gone', async () => {
    issueCommentEvent.comment.body = '/remove some-label'
    const commentContext = new utils.MockContext(issueCommentEvent)

    server.use(
      http.delete(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1/labels/some-label`,
        utils.mockResponse(404),
      ),
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1`,
        utils.mockResponse(200, issuePayload),
      ),
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/collaborators/Codertocat`,
        utils.mockResponse(204),
      ),
    )

    const setFailed = jest.spyOn(core, 'setFailed').mockImplementation(() => {})
    await handleIssueComment(commentContext)
    expect(setFailed).not.toHaveBeenCalled()
  })
})
