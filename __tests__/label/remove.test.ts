import * as core from '@actions/core'
import { http } from 'msw'

import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { handleIssueComment } from '../../src/issueComment/handleIssueComment'
import issuePayload from '../fixtures/issues/issue.json'

import issueCommentEvent from '../fixtures/issues/issueCommentEvent.json'
import * as utils from '../testUtils'

const server = setupServer()
utils.failTestOnUnhandledRequests(server)
beforeAll(() =>
  server.listen(utils.failOnUnhandledRequest),
)
// a label command is followed by the needs-* re-check and the merge gate: no prow.yaml in any tier, no OWNERS files
beforeEach(() => server.use(...utils.noOrgOrRepoConfigExcept(), utils.defaultBranchTree()))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

describe('remove', () => {
  beforeEach(() => {
    utils.setupActionsEnv('/remove')
  })

  it('removes the specified label', async () => {
    issueCommentEvent.comment.body = '/remove some-label'
    const commentContext = new utils.MockContext(issueCommentEvent)

    const removeSomeLabel = new utils.ObserveRequest()
    server.use(
      http.delete(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1/labels/some-label`,
        utils.mockResponse(200, null, removeSomeLabel),
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

    const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})
    await handleIssueComment(commentContext)
    await expect(removeSomeLabel.called()).resolves.toBe('called')
    expect(setFailed).not.toHaveBeenCalled()
  })

  it('removes multiple labels', async () => {
    issueCommentEvent.comment.body = '/remove some-label some-other-label'
    const commentContext = new utils.MockContext(issueCommentEvent)

    const removeSomeLabel = new utils.ObserveRequest()
    const removeSomeOtherLabel = new utils.ObserveRequest()
    server.use(
      http.delete(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1/labels/some-label`,
        utils.mockResponse(200, null, removeSomeLabel),
      ),
      http.delete(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1/labels/some-other-label`,
        utils.mockResponse(200, null, removeSomeOtherLabel),
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

    const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})
    await handleIssueComment(commentContext)
    // every requested label is removed, not just the first
    await expect(removeSomeLabel.called()).resolves.toBe('called')
    await expect(removeSomeOtherLabel.called()).resolves.toBe('called')
    expect(setFailed).not.toHaveBeenCalled()
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

    const spy = vi.spyOn(core, 'setFailed')
    await handleIssueComment(commentContext)
    expect(spy).toHaveBeenCalled()
  })

  it('fails when none of the requested labels are on the issue', async () => {
    issueCommentEvent.comment.body = '/remove not-present'
    const commentContext = new utils.MockContext(issueCommentEvent)

    const observeReq = new utils.ObserveRequest()
    server.use(
      http.delete(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1/labels/not-present`,
        utils.mockResponse(200, null, observeReq),
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

    const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})
    await handleIssueComment(commentContext)
    await expect(observeReq.notCalled()).resolves.toBe('not called')
    expect(setFailed).toHaveBeenCalledWith(
      expect.stringContaining('command args missing from body'),
    )
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

    const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})
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

    const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})
    await handleIssueComment(commentContext)
    expect(setFailed).not.toHaveBeenCalled()
  })
})
