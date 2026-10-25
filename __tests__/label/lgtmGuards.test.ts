import * as core from '@actions/core'
import { http } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { lgtm } from '../../src/labels/lgtm'

import issuePayload from '../fixtures/issues/issue.json'
import issueCommentEvent from '../fixtures/issues/issueCommentEvent.json'
import * as utils from '../testUtils'

// Guards and log lines of src/labels/lgtm.ts that the rest of the suite
// reaches but never distinguishes from their mutation: each case here fails
// when the guarded expression is replaced by a constant or the log call is
// removed. The fixture's commenter is the issue author, so a plain /lgtm is
// refused before any authorization read, and a cancel needs no reviewer check.

const server = setupServer()
beforeAll(() => server.listen(utils.failOnUnhandledRequest))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

const issue = `${utils.api}/repos/Codertocat/Hello-World/issues/1`

function comment(body: string) {
  const payload = structuredClone(issueCommentEvent)
  payload.comment.body = body
  return new utils.MockContext(payload)
}

function issueWithLabels(...names: string[]) {
  const payload = structuredClone(issuePayload)
  payload.labels = names.map(name => ({ ...payload.labels[0], name }))
  return payload
}

beforeEach(() => {
  utils.setupActionsEnv()
  vi.restoreAllMocks()
})

describe('/lgtm guards', () => {
  it('requires the github-token input before reading anything', async () => {
    delete process.env['INPUT_GITHUB-TOKEN']
    const observeComment = new utils.ObserveRequest()
    server.use(http.post(`${issue}/comments`, utils.mockResponse(200, null, observeComment)))

    await expect(lgtm(comment('/lgtm'))).rejects.toThrow('Input required and not supplied: github-token')

    await expect(observeComment.notCalled()).resolves.toBe('not called')
  })

  it('a refusal is logged as an error with the same message it replies with', async () => {
    const observeComment = new utils.ObserveRequest()
    server.use(http.post(`${issue}/comments`, utils.mockResponse(200, null, observeComment)))
    const error = vi.spyOn(core, 'error').mockImplementation(() => {})

    await expect(lgtm(comment('/lgtm'))).rejects.toThrow('you cannot LGTM your own PR.')

    expect(await observeComment.body()).toEqual({ body: 'you cannot LGTM your own PR.' })
    expect(error).toHaveBeenCalledExactlyOnceWith('you cannot LGTM your own PR.')
  })

  it('a cancel on an issue without the label says so in the debug log and removes nothing', async () => {
    const observeRemove = new utils.ObserveRequest()
    server.use(
      http.get(issue, utils.mockResponse(200, issueWithLabels('approved'))),
      http.delete(`${issue}/labels/lgtm`, utils.mockResponse(200, [], observeRemove)),
    )
    const debug = vi.spyOn(core, 'debug').mockImplementation(() => {})

    await expect(lgtm(comment('/lgtm cancel'))).resolves.toBeUndefined()

    expect(debug).toHaveBeenCalledWith('could not find lgtm to remove')
    await expect(observeRemove.notCalled()).resolves.toBe('not called')
  })
})
