import type { FakeGithub } from './fakeGithub'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import issueCommentEvent from '../fixtures/issues/issueCommentEvent.json'
import { start } from './fakeGithub'
import { token } from './helpers'
import { runBundle } from './runBundle'

vi.setConfig({ testTimeout: 30_000 })

// Every event handler reports its own failures, so the last-resort catch in run()
// (run.ts:40) only sees an exception a handler never anticipated. A comment whose
// `body` is not a string is one: handleIssueComment folds only null/undefined to ''
// (handleIssueComment.ts:117), so command matching calls String.prototype methods on
// it and throws a TypeError that rejects the handler. run() must turn that into a
// failed step with the message, not an unhandled rejection or a silent exit 0.
describe('dist/index.js run() when a handler rejects', () => {
  let gh: FakeGithub

  beforeAll(async () => {
    gh = await start()
  })
  afterEach(() => gh.reset())
  afterAll(() => gh.close())

  it.each([
    ['a numeric body', 42],
    ['an object body', { text: '/assign' }],
  ])('fails the step with the rejection message for %s, with no api call', async (_name, body) => {
    const payload = structuredClone(issueCommentEvent) as Record<string, unknown>
    payload.comment = { ...issueCommentEvent.comment, body }

    const result = await runBundle({
      eventName: 'issue_comment',
      payload,
      inputs: { ...token, 'prow-commands': '/assign' },
      apiUrl: gh.url,
    })

    expect(result.status).toBe(1)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toMatch(/\.replace is not a function/)
    expect(result.stderr).not.toMatch(/Unhandled|unhandledRejection/)
    expect(gh.requests).toEqual([])
  })
})
