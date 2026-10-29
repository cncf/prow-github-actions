import type { MockInstance } from 'vitest'
import dns from 'node:dns'
import * as core from '@actions/core'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { handleIssueComment } from '../../src/issueComment/handleIssueComment'
import { meowConfig } from '../../src/issueComment/meow'
import * as comments from '../../src/utils/comments'
import issueCommentEvent from '../fixtures/issues/issueCommentEvent.json'
import * as utils from '../testUtils'

const catApi = 'https://api.thecatapi.com/v1/images/search'

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

// Pins the edges of `parseCatImage` / `isTrustedImageSource`
// (src/issueComment/meow.ts) that meow.test.ts reaches but never
// distinguishes: the s3 fallback must check the host and not only the path
// prefix, a url with only a username or only a password is refused, and the
// length bound is inclusive at 4096.
describe('/meow image validation edges', () => {
  let createComment: ReturnType<typeof vi.spyOn<typeof comments, 'createComment'>>

  beforeEach(() => {
    utils.setupActionsEnv('/meow')
    meowConfig.timeoutMs = 10_000
    meowConfig.retryDelayMs = 0
    meowConfig.maxAttempts = 3
    createComment = vi.spyOn(comments, 'createComment').mockResolvedValue()
    vi.spyOn(core, 'warning').mockImplementation(() => {})
  })

  function expectNote() {
    expect(createComment).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      1,
      'The cat API is unavailable right now.',
    )
  }

  it('does not trust the provider path prefix on a foreign host', async () => {
    server.use(http.get(catApi, () =>
      HttpResponse.json([{ url: 'https://evil.example/cdn2.thecatapi.com/images/cat.jpg' }])))

    await handleIssueComment(contextFor('/meow'))

    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining('unexpected host'))
    expectNote()
  })

  it.each([
    ['a username only', 'https://user@cdn2.thecatapi.com/images/cat.jpg'],
    ['a password only', 'https://:secret@cdn2.thecatapi.com/images/cat.jpg'],
  ])('degrades to a note for a url that embeds %s', async (_, url) => {
    server.use(http.get(catApi, () => HttpResponse.json([{ url }])))

    await handleIssueComment(contextFor('/meow'))

    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining('unusable image url'))
    expectNote()
  })

  it('renders a url of exactly 4096 characters and refuses one character more', async () => {
    const prefix = 'https://cdn2.thecatapi.com/images/'
    const atBound = `${prefix}${'a'.repeat(4096 - prefix.length - 4)}.jpg`
    expect(atBound).toHaveLength(4096)
    server.use(http.get(catApi, () => HttpResponse.json([{ url: atBound }])))

    await handleIssueComment(contextFor('/meow'))

    expect(createComment).toHaveBeenCalledWith(expect.anything(), expect.anything(), 1, `![cat](<${atBound}>)`)

    createComment.mockClear()
    server.use(http.get(catApi, () => HttpResponse.json([{ url: `${atBound}g` }])))

    await handleIssueComment(contextFor('/meow'))

    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining('excessively long'))
    expectNote()
  })
})
