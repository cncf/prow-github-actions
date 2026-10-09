import type { FakeGithub } from './fakeGithub'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { start } from './fakeGithub'
import { comment, helpersFor, token } from './helpers'
import { runBundle } from './runBundle'

vi.setConfig({ testTimeout: 30_000 })

// without CAT_API_URL the preload makes any cat api call throw, so a meow that got past the
// strict command check would post the unavailable note to the fake github and show up in calls()
const preload = path.resolve(__dirname, 'catApiPreload.cjs')

// handleIssueComment admits /meow with the generic matcher (case-insensitive, arguments allowed);
// meow.ts then re-checks the line against its own stricter pattern (meow.ts:12) and returns at
// meow.ts:28 when only the generic one matched. This body passes the first gate and fails the second.
describe('dist/index.js issue_comment /meow strict command shape', () => {
  let gh: FakeGithub
  const { calls } = helpersFor(() => gh)

  beforeAll(async () => {
    gh = await start()
  })
  afterEach(() => {
    gh.reset()
  })
  afterAll(async () => {
    await gh.close()
  })

  function meow(body: string) {
    return runBundle({
      eventName: 'issue_comment',
      payload: comment(body),
      inputs: { ...token, 'prow-commands': '/meow' },
      apiUrl: gh.url,
      env: { NODE_OPTIONS: `--require "${preload}"` },
    })
  }

  it('/meow with an argument reaches the handler but posts nothing and succeeds', async () => {
    const result = await meow('/meow cat')

    expect(result.status, result.stdout).toBe(0)
    expect(result.errors).toEqual([])
    expect(result.stdout).not.toMatch(/::warning::/)
    expect(calls()).toEqual([])
  })
})
