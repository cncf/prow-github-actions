import type { FakeGithub } from './fakeGithub'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { start } from './fakeGithub'
import { comment, helpersFor, repo, token } from './helpers'
import { runBundle } from './runBundle'

vi.setConfig({ testTimeout: 30_000 })

const issueRead = `GET ${repo}/issues/1`

// the two arms of removeFixedLabels (src/labels/fixed.ts) that dist/index.js is not otherwise driven through:
// a /remove- form whose labels are not on the issue, and a failed read of the issue's current labels
describe('dist/index.js fixed label removal arms', () => {
  let gh: FakeGithub
  const { calls, expectCommandThenConfig } = helpersFor(() => gh)

  beforeAll(async () => {
    gh = await start()
  })
  afterEach(() => gh.reset())
  afterAll(() => gh.close())

  function run(body: string, command: string) {
    return runBundle({ eventName: 'issue_comment', payload: comment(body), inputs: { ...token, 'prow-commands': command }, apiUrl: gh.url })
  }

  it('/remove-good-first-issue with none of its labels on the issue reads the labels and removes nothing', async () => {
    gh.route('GET', `${repo}/issues/1`, { status: 200, body: { labels: [{ name: 'help wanted' }, { name: 'kind/bug' }] } })

    const result = await run('/remove-good-first-issue', '/good-first-issue')

    expect(result.status, result.stdout).toBe(0)
    expect(result.errors).toEqual([])
    expect(gh.requestsMatching('DELETE', /./)).toEqual([])
    expect(gh.requestsMatching('POST', /./)).toEqual([])
    expectCommandThenConfig([issueRead])
  })

  it('/remove-help fails the run naming the labels read when the issue cannot be read', async () => {
    gh.route('GET', `${repo}/issues/1`, { status: 500, body: { message: 'boom' } })

    const result = await run('/remove-help', '/help')

    expect(result.status, result.stdout).toBe(1)
    expect(result.errors.some(e => e.includes('could not get labels from issue'))).toBe(true)
    expect(gh.requestsMatching('DELETE', /./)).toEqual([])
    expect(calls().filter(c => c === issueRead)).toHaveLength(1)
  })
})
