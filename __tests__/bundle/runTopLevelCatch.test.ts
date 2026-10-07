import type { FakeGithub } from './fakeGithub'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import issueCommentEvent from '../fixtures/issues/issueCommentEvent.json'
import { start } from './fakeGithub'
import { token } from './helpers'
import { runBundle } from './runBundle'

vi.setConfig({ testTimeout: 30_000 })

// run()'s top-level catch (src/run.ts), driven through dist/index.js. Every event handler swallows
// its own rejections, so the only way to reach it is a throw that happens before a per-command
// catch: handleIssueComment matches the comment body against each configured command without
// guarding it, and a payload whose comment has no body makes that match throw a TypeError.
describe('dist/index.js fails the run once from run()\'s top-level catch', () => {
  let gh: FakeGithub

  beforeAll(async () => {
    gh = await start()
  })
  afterEach(() => gh.reset())
  afterAll(() => gh.close())

  function withoutBody(body: unknown) {
    const payload = structuredClone(issueCommentEvent) as Record<string, any>
    if (body === undefined)
      delete payload.comment
    else
      payload.comment.body = body
    return payload
  }

  it.each([
    ['no comment object', undefined, 'undefined'],
    ['a null comment body', null, 'null'],
  ])('issue_comment with %s: exits 1 with one error and no api call', async (_name, body, kind) => {
    const result = await runBundle({
      eventName: 'issue_comment',
      payload: withoutBody(body),
      inputs: { ...token, 'prow-commands': '/assign /lgtm' },
      apiUrl: gh.url,
    })

    expect(result.status, result.stdout).toBe(1)
    expect(result.errors).toEqual([`Cannot read properties of ${kind} (reading 'replace')`])
    expect(result.stdout).not.toContain('not yet supported')
    expect(gh.requests).toEqual([])
  })
})
