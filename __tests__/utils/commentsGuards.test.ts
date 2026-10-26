import { http } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createComment, createCommentOnce, isBotUser } from '../../src/utils/comments'
import { newOctokit } from '../../src/utils/octokit'
import issueCommentEvent from '../fixtures/issues/issueCommentEvent.json'
import * as utils from '../testUtils'

const server = setupServer()
beforeAll(() => server.listen(utils.failOnUnhandledRequest))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

const commentsUrl = `${utils.api}/repos/Codertocat/Hello-World/issues/1/comments`
const marker = '<!-- prow-github-actions/test: abc1234 -->'

describe('isBotUser', () => {
  it.each([
    ['the Bot type under any login', { login: 'some-app[bot]', type: 'Bot' }, true],
    ['the github-actions[bot] login when the type is missing', { login: 'github-actions[bot]' }, true],
    ['the github-actions[bot] login when the type says User', { login: 'github-actions[bot]', type: 'User' }, true],
    ['a human', { login: 'Codertocat', type: 'User' }, false],
    ['a login that only starts with github-actions', { login: 'github-actions', type: 'User' }, false],
    ['an empty user', {}, false],
    ['null', null, false],
    ['undefined', undefined, false],
  ])('%s', (_name, user, expected) => {
    expect(isBotUser(user)).toBe(expected)
  })
})

describe('createComment', () => {
  const context = new utils.MockContext(issueCommentEvent)

  beforeEach(() => {
    utils.setupActionsEnv()
  })

  it('rewraps a refused post as "could not add comment" with the HttpError inside', async () => {
    server.use(http.post(commentsUrl, utils.mockResponse(403, { message: 'Resource not accessible by integration' })))

    const posted = createComment(newOctokit('some-token'), context, 1, 'hello')
    await expect(posted).rejects.toThrow(/^could not add comment: HttpError: Resource not accessible by integration/)
  })
})

describe('createCommentOnce', () => {
  const context = new utils.MockContext(issueCommentEvent)

  beforeEach(() => {
    utils.setupActionsEnv()
  })

  it('treats a github-actions[bot] comment without a user type as its own and does not post again', async () => {
    const observeReq = new utils.ObserveRequest()
    server.use(
      http.get(commentsUrl, utils.mockResponse(200, [{ id: 1, user: { login: 'github-actions[bot]' }, body: `earlier\n\n${marker}` }])),
      http.post(commentsUrl, utils.mockResponse(201, {}, observeReq)),
    )

    await expect(createCommentOnce(newOctokit('some-token'), context, 1, marker, 'hello')).resolves.toBe(false)
    await expect(observeReq.notCalled()).resolves.toBe('not called')
  })
})
