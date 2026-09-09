import * as core from '@actions/core'
import { http } from 'msw'

import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { handleIssueComment } from '../../src/issueComment/handleIssueComment'

import issueCommentEvent from '../fixtures/issues/issueCommentEvent.json'

import repoMilestones from '../fixtures/milestones/repoListMilestones.json'
import * as utils from '../testUtils'

const server = setupServer()
beforeAll(() =>
  server.listen({
    onUnhandledRequest: 'error',
  }),
)
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

describe('/milestone', () => {
  beforeEach(() => {
    utils.setupActionsEnv('/milestone')
  })

  it('adds issue to milestone that already exists', async () => {
    issueCommentEvent.comment.body = '/milestone some milestone'

    server.use(
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/milestones`,
        utils.mockResponse(200, repoMilestones),
      ),
    )

    const observeReq = new utils.ObserveRequest()
    server.use(
      http.patch(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1`,
        utils.mockResponse(200, null, observeReq),
      ),
    )

    server.use(
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/collaborators/Codertocat`,
        utils.mockResponse(204),
      ),
    )

    const commentContext = new utils.MockContext(issueCommentEvent)

    await handleIssueComment(commentContext)
    await observeReq.called()
    expect(await observeReq.body()).toMatchObject({
      milestone: 1,
    })
  })

  it('fails when commenter is not a collaborator', async () => {
    issueCommentEvent.comment.body = '/milestone some milestone'

    server.use(
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/milestones`,
        utils.mockResponse(200, repoMilestones),
      ),
    )

    server.use(
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/collaborators/Codertocat`,
        utils.mockResponse(404),
      ),
    )

    const commentContext = new utils.MockContext(issueCommentEvent)

    const spy = vi.spyOn(core, 'setFailed')
    await handleIssueComment(commentContext)
    expect(spy).toHaveBeenCalled()
  })

  it('does not update the issue when the milestone does not exist', async () => {
    issueCommentEvent.comment.body = '/milestone does not exist'

    server.use(
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/milestones`,
        utils.mockResponse(200, repoMilestones),
      ),
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

    const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})
    await handleIssueComment(commentContext)
    await expect(observeReq.notCalled()).resolves.toBe('not called')
    expect(setFailed).not.toHaveBeenCalled()
  })

  it('fails when no milestone is provided', async () => {
    issueCommentEvent.comment.body = '/milestone'

    server.use(
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/collaborators/Codertocat`,
        utils.mockResponse(204),
      ),
    )

    const commentContext = new utils.MockContext(issueCommentEvent)

    const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})
    await handleIssueComment(commentContext)
    expect(setFailed).toHaveBeenCalledWith(
      expect.stringContaining('please provide a milestone to add'),
    )
  })
})
