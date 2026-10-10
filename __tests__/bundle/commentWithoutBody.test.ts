import type { FakeGithub } from './fakeGithub'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import issueCommentEvent from '../fixtures/issues/issueCommentEvent.json'
import { start } from './fakeGithub'
import { token } from './helpers'
import { runBundle } from './runBundle'

vi.setConfig({ testTimeout: 30_000 })

// GitHub allows an empty comment, whose `body` arrives as null; handleIssueComment folds it
// (and a payload with no `comment` at all) into '' before matching commands (handleIssueComment.ts:117)
describe('dist/index.js issue_comment without a body', () => {
  let gh: FakeGithub

  beforeAll(async () => {
    gh = await start()
  })
  afterEach(() => gh.reset())
  afterAll(() => gh.close())

  const { body: _body, ...commentWithoutBody } = issueCommentEvent.comment

  function payloadWith(comment: Record<string, unknown> | undefined) {
    const payload = structuredClone(issueCommentEvent) as Record<string, unknown>
    if (comment === undefined)
      delete payload.comment
    else
      payload.comment = comment
    return payload
  }

  it.each([
    ['a null body', () => payloadWith({ ...commentWithoutBody, body: null })],
    ['no body field', () => payloadWith(commentWithoutBody)],
    ['no comment at all', () => payloadWith(undefined)],
  ])('runs no command and succeeds with %s, with no api call', async (_name, payloadFor) => {
    const result = await runBundle({
      eventName: 'issue_comment',
      payload: payloadFor(),
      inputs: { ...token, 'prow-commands': '/assign /approve /lgtm /hold /kind /meow /retest /check-required-labels' },
      apiUrl: gh.url,
    })

    expect(result.status, result.stdout).toBe(0)
    expect(result.errors).toEqual([])
    expect(gh.requests).toEqual([])
  })
})
