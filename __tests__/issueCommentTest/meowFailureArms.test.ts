import type { MockInstance } from 'vitest'
import dns from 'node:dns'
import * as core from '@actions/core'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { handleIssueComment } from '../../src/issueComment/handleIssueComment'
import { meow, meowConfig } from '../../src/issueComment/meow'
import * as comments from '../../src/utils/comments'
import issueCommentEvent from '../fixtures/issues/issueCommentEvent.json'
import * as utils from '../testUtils'

const catApi = 'https://api.thecatapi.com/v1/images/search'
const image = 'https://cdn2.thecatapi.com/images/cat.jpg'

const server = setupServer()
utils.failTestOnUnhandledRequests(server)

// as in meow.test.ts: a socket the interceptor passed through to the real network is the only way to reach dns
let lookup: MockInstance<typeof dns.lookup>

beforeAll(() => server.listen(utils.failOnUnhandledRequest))
beforeEach(() => {
  lookup = vi.spyOn(dns, 'lookup')
})
afterEach(async () => {
  server.resetHandlers()
  await new Promise(resolve => setImmediate(resolve))
  await new Promise(resolve => setImmediate(resolve))
  expect(lookup.mock.calls.map(call => call[0])).toEqual([])
})
afterAll(() => server.close())

function contextFor(body: string) {
  issueCommentEvent.comment.body = body
  return new utils.MockContext(issueCommentEvent)
}

// Pins the arms of `fetchCatImage` / `parseCatImage` (src/issueComment/meow.ts)
// that meow.test.ts reaches but never distinguishes: every refusal degrades to
// the same note there, so the warning that names the cause, the number of
// requests a refusal costs, the retry delay and the zero-attempt fallback were
// all unasserted.
describe('/meow failure arms', () => {
  let createComment: MockInstance<typeof comments.createComment>
  let warning: MockInstance<typeof core.warning>

  beforeEach(() => {
    utils.setupActionsEnv('/meow')
    meowConfig.timeoutMs = 10_000
    meowConfig.retryDelayMs = 0
    meowConfig.maxAttempts = 3
    createComment = vi.spyOn(comments, 'createComment').mockResolvedValue()
    warning = vi.spyOn(core, 'warning').mockImplementation(() => {})
  })

  function expectNote() {
    expect(createComment).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      1,
      'The cat API is unavailable right now.',
    )
  }

  // a malformed 2xx is refused once; only a network failure or a 5xx is retried
  it.each([
    ['an empty list', [], 'cat api returned no images'],
    ['a non-array body', { url: image }, 'cat api returned no images'],
    ['a null first item', [null], 'cat api returned an invalid image record'],
    ['a first item without a url', [{}], 'cat api returned an invalid image record'],
    ['a non-string url', [{ url: 42 }], 'cat api returned an invalid image record'],
    ['an unparsable url', [{ url: 'not a url' }], 'cat api returned an invalid image url'],
  ])('warns with the cause for %s and does not retry', async (_, body, cause) => {
    let calls = 0
    server.use(http.get(catApi, () => {
      calls++
      return HttpResponse.json(body)
    }))

    await handleIssueComment(contextFor('/meow'))

    expect(calls).toBe(1)
    expect(warning).toHaveBeenCalledWith(`Could not fetch a cat image: Error: ${cause}`)
    expectNote()
  })

  it('warns with the last status when every attempt is a server error', async () => {
    let calls = 0
    server.use(http.get(catApi, () => {
      calls++
      return new HttpResponse(null, { status: calls === meowConfig.maxAttempts ? 502 : 500, headers: { 'content-length': '0' } })
    }))

    await handleIssueComment(contextFor('/meow'))

    expect(calls).toBe(meowConfig.maxAttempts)
    expect(warning).toHaveBeenCalledWith('Could not fetch a cat image: Error: cat api responded with 502')
    expectNote()
  })

  it('warns with the client status without retrying', async () => {
    server.use(http.get(catApi, () => new HttpResponse(null, { status: 404, headers: { 'content-length': '0' } })))

    await handleIssueComment(contextFor('/meow'))

    expect(warning).toHaveBeenCalledWith('Could not fetch a cat image: Error: cat api responded with 404')
    expectNote()
  })

  it('waits retryDelayMs before each retry and not before the first attempt', async () => {
    meowConfig.retryDelayMs = 123
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
    let calls = 0
    server.use(http.get(catApi, () => {
      calls++
      if (calls === 1)
        return new HttpResponse(null, { status: 503, headers: { 'content-length': '0' } })
      return HttpResponse.json([{ url: image }])
    }))

    await handleIssueComment(contextFor('/meow'))

    expect(calls).toBe(2)
    const delays = setTimeoutSpy.mock.calls.filter(call => call[1] === 123)
    expect(delays).toHaveLength(1)
    expect(createComment).toHaveBeenCalledWith(expect.anything(), expect.anything(), 1, `![cat](<${image}>)`)
  })

  it('does not wait at all when the first attempt succeeds', async () => {
    meowConfig.retryDelayMs = 123
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
    server.use(http.get(catApi, () => HttpResponse.json([{ url: image }])))

    await handleIssueComment(contextFor('/meow'))

    expect(setTimeoutSpy.mock.calls.filter(call => call[1] === 123)).toHaveLength(0)
    expect(createComment).toHaveBeenCalledWith(expect.anything(), expect.anything(), 1, `![cat](<${image}>)`)
  })

  it('degrades without a request when no attempt is allowed', async () => {
    meowConfig.maxAttempts = 0
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    await handleIssueComment(contextFor('/meow'))

    expect(fetchSpy).not.toHaveBeenCalled()
    expect(warning).toHaveBeenCalledWith('Could not fetch a cat image: Error: cat api was not reached')
    expectNote()
  })

  it('asks the provider for json', async () => {
    let accept: string | null = null
    server.use(http.get(catApi, ({ request }) => {
      accept = request.headers.get('accept')
      return HttpResponse.json([{ url: image }])
    }))

    await handleIssueComment(contextFor('/meow'))

    expect(accept).toBe('application/json')
  })

  it.each([
    ['no body', (payload: { comment?: { body?: unknown } }) => {
      delete payload.comment!.body
    }],
    ['a non-string body', (payload: { comment?: { body?: unknown } }) => {
      payload.comment!.body = 42
    }],
    ['no comment', (payload: { comment?: unknown }) => {
      delete payload.comment
    }],
  ])('makes no request and no comment for a payload with %s', async (_, strip) => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const context = contextFor('/meow')
    strip(context.payload as { comment?: { body?: unknown } })

    await meow(context)

    expect(fetchSpy).not.toHaveBeenCalled()
    expect(createComment).not.toHaveBeenCalled()
  })
})
