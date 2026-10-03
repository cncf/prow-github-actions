import { http } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createCommentOnce } from '../../src/utils/comments'
import { newOctokit } from '../../src/utils/octokit'
import issueCommentEvent from '../fixtures/issues/issueCommentEvent.json'
import * as utils from '../testUtils'

const server = setupServer()
beforeAll(() => server.listen(utils.failOnUnhandledRequest))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

const commentsUrl = `${utils.api}/repos/Codertocat/Hello-World/issues/1/comments`
const marker = '<!-- prow-github-actions/test: abc1234 -->'
const bot = { login: 'github-actions[bot]', type: 'Bot' }

describe('createCommentOnce', () => {
  const context = new utils.MockContext(issueCommentEvent)

  beforeEach(() => {
    utils.setupActionsEnv()
  })

  it('posts when the only bot comment has no body', async () => {
    const observeReq = new utils.ObserveRequest()
    server.use(
      http.get(commentsUrl, utils.mockResponse(200, [{ id: 1, user: bot, body: null }])),
      http.post(commentsUrl, utils.mockResponse(201, {}, observeReq)),
    )

    await expect(createCommentOnce(newOctokit('some-token'), context, 1, marker, 'hello')).resolves.toBe(true)

    await observeReq.called()
    expect(await observeReq.body()).toMatchObject({ body: `hello\n\n${marker}` })
  })

  it('does not post when a bot comment already carries the marker', async () => {
    const observeReq = new utils.ObserveRequest()
    server.use(
      http.get(commentsUrl, utils.mockResponse(200, [{ id: 1, user: bot, body: `earlier\n\n${marker}` }])),
      http.post(commentsUrl, utils.mockResponse(201, {}, observeReq)),
    )

    await expect(createCommentOnce(newOctokit('some-token'), context, 1, marker, 'hello')).resolves.toBe(false)
    await expect(observeReq.notCalled()).resolves.toBe('not called')
  })

  it('ignores the marker in a human comment', async () => {
    const observeReq = new utils.ObserveRequest()
    server.use(
      http.get(commentsUrl, utils.mockResponse(200, [{ id: 1, user: { login: 'Codertocat', type: 'User' }, body: marker }])),
      http.post(commentsUrl, utils.mockResponse(201, {}, observeReq)),
    )

    await expect(createCommentOnce(newOctokit('some-token'), context, 1, marker, 'hello')).resolves.toBe(true)
    await observeReq.called()
  })
})
