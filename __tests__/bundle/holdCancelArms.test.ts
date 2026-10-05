import type { FakeGithub } from './fakeGithub'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { start } from './fakeGithub'
import { comment, configReads, helpersFor, repo, token } from './helpers'
import { runBundle } from './runBundle'

vi.setConfig({ testTimeout: 30_000 })

// the arms of cancelHold in src/labels/hold.ts that bundle.test.ts's /unhold case (both labels present, every
// write accepted) does not reach: nothing to remove, a failed labels read, a failed removal, and a label that
// was already gone when the DELETE arrived
describe('dist/index.js /hold cancel arms', () => {
  let gh: FakeGithub
  const { expectRequests } = helpersFor(() => gh)

  beforeAll(async () => {
    gh = await start()
  })
  afterEach(() => gh.reset())
  afterAll(() => gh.close())

  function run(body: string) {
    return runBundle({ eventName: 'issue_comment', payload: comment(body), inputs: { ...token, 'prow-commands': '/hold' }, apiUrl: gh.url })
  }

  it.each(['/hold cancel', '/unhold', '/remove-hold'])('%s on an issue without a hold label succeeds and deletes nothing', async (body) => {
    gh.route('GET', `${repo}/issues/1`, { status: 200, body: { labels: [{ name: 'lgtm' }] } })

    const result = await run(body)

    expect(result.status, result.stdout).toBe(0)
    expect(result.errors).toEqual([])
    expect(gh.requestsMatching('DELETE', /./)).toEqual([])
    expectRequests(configReads(), [`GET ${repo}/issues/1`])
  })

  it('/hold cancel fails naming the labels read when GET /issues/1 answers 500, and deletes nothing', async () => {
    gh.route('GET', `${repo}/issues/1`, { status: 500, body: { message: 'boom' } })

    const result = await run('/hold cancel')

    expect(result.status, result.stdout).toBe(1)
    expect(result.errors.some(e => e.includes('could not get labels from issue'))).toBe(true)
    expect(gh.requestsMatching('DELETE', /./)).toEqual([])
    expectRequests(configReads(), [`GET ${repo}/issues/1`])
  })

  it('/hold cancel fails naming the hold label when the DELETE answers 500', async () => {
    gh.route('GET', `${repo}/issues/1`, { status: 200, body: { labels: [{ name: 'do-not-merge/hold' }] } })
    gh.route('DELETE', `${repo}/issues/1/labels/do-not-merge%2Fhold`, { status: 500, body: { message: 'boom' } })

    const result = await run('/hold cancel')

    expect(result.status, result.stdout).toBe(1)
    expect(result.errors.some(e => e.includes('could not remove the hold label'))).toBe(true)
    expect(result.errors.some(e => e.includes('could not remove label do-not-merge/hold'))).toBe(true)
    expectRequests(configReads(), [`GET ${repo}/issues/1`, `DELETE ${repo}/issues/1/labels/do-not-merge%2Fhold`])
  })

  it('/hold cancel treats a label that is already gone (DELETE 404) as removed', async () => {
    gh.route('GET', `${repo}/issues/1`, { status: 200, body: { labels: [{ name: 'hold' }, { name: 'do-not-merge/hold' }] } })
    gh.route('DELETE', `${repo}/issues/1/labels/hold`, { status: 404, body: { message: 'Label does not exist' } })
    gh.route('DELETE', `${repo}/issues/1/labels/do-not-merge%2Fhold`, { status: 200, body: [] })

    const result = await run('/hold cancel')

    expect(result.status, result.stdout).toBe(0)
    expect(result.errors).toEqual([])
    expectRequests(configReads(), [
      `GET ${repo}/issues/1`,
      `DELETE ${repo}/issues/1/labels/hold`,
      `DELETE ${repo}/issues/1/labels/do-not-merge%2Fhold`,
    ])
  })
})
