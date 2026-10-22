import type { FakeGithub } from './fakeGithub'
import { Buffer } from 'node:buffer'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import labelFileContents from '../fixtures/labels/labelFileContentsResp.json'
import pullReqListPulls from '../fixtures/pullReq/pullReqListPulls.json'
import { blobSha } from '../utils/ownersData'
import { start } from './fakeGithub'
import { repo, token } from './helpers'
import { runBundle } from './runBundle'

vi.setConfig({ testTimeout: 30_000 })

// The recovery expectation of the delayed-reviewers sweep after the schedule
// missed runs for longer than `sweep.lookback` (src/cronJobs/sweep.ts, `sweep`
// → `recentlyUpdatedPulls` with `due.from`): the list stops at
// `now − delay − lookback`, so a pull request nobody touched since its review
// clock expired before that instant is neither listed, read nor requested.
// There is no unbounded catch-up; a longer `sweep.lookback` (capped at 24h) is
// what widens the window.
describe('dist/index.js delayed blunderbuss after missed schedule runs', () => {
  let gh: FakeGithub
  const owners = { OWNERS: 'reviewers:\n- bob\n' }

  beforeAll(async () => {
    gh = await start()
  })
  afterEach(() => gh.reset())
  afterAll(() => gh.close())

  function ago(minutes: number) {
    return new Date(Date.now() - minutes * 60_000).toISOString()
  }

  function pull(number: number, minutesAgo: number) {
    return {
      ...structuredClone(pullReqListPulls[0]),
      number,
      created_at: ago(minutesAgo),
      updated_at: ago(minutesAgo),
      labels: [],
      requested_reviewers: [],
      requested_teams: [],
      assignees: [],
      draft: false,
      user: { login: 'Codertocat' },
      base: { ref: 'master', sha: 'basesha' },
      head: { sha: `sha${number}`, repo: { full_name: 'Codertocat/Hello-World' } },
    }
  }

  // #1 opened 90 minutes ago sits inside the default due window [now − 2h, now − 1h];
  // #2 opened 2.5 hours ago fell out of it while no sweep ran, and nobody touched it since
  const pulls = [pull(1, 90), pull(2, 150)]

  function serve(config: string) {
    const file = structuredClone(labelFileContents)
    file.content = Buffer.from(config).toString('base64')
    gh.route('GET', '/repos/Codertocat/.project/contents/prow.yaml', { status: 200, body: file })
    gh.route('GET', new RegExp(`^${repo}/pulls\\?`), { status: 200, body: pulls })
    for (const pr of pulls) {
      gh.route('GET', `${repo}/pulls/${pr.number}`, { status: 200, body: pr })
      gh.route('GET', `${repo}/pulls/${pr.number}/files`, { status: 200, body: [{ filename: 'x.go', status: 'modified' }] })
      gh.route('GET', `${repo}/issues/${pr.number}/timeline`, { status: 200, body: [] })
      gh.route('GET', `${repo}/pulls/${pr.number}/reviews`, { status: 200, body: [] })
      gh.route('POST', `${repo}/pulls/${pr.number}/requested_reviewers`, { status: 201, body: {} })
      // a candidate inside the plain window runs every sweep step, not only the delayed reviewers
      gh.route('GET', `${repo}/issues/${pr.number}`, { status: 200, body: { labels: [] } })
      gh.route('GET', `${repo}/issues/${pr.number}/comments`, { status: 200, body: [] })
      gh.route('POST', `${repo}/issues/${pr.number}/comments`, { status: 201, body: {} })
    }
    gh.route('GET', `${repo}/branches/master`, { status: 200, body: { name: 'master', commit: { sha: 'basesha' } } })
    const tree = Object.keys(owners).map(path => ({ path, type: 'blob', sha: blobSha(path) }))
    gh.route('GET', `${repo}/git/trees/master`, { status: 200, body: { sha: 'master', truncated: false, tree } })
    gh.route('GET', `${repo}/git/trees/basesha`, { status: 200, body: { sha: 'basesha', truncated: false, tree } })
    for (const [path, contents] of Object.entries(owners)) {
      gh.route('GET', `${repo}/git/blobs/${blobSha(path)}`, { status: 200, body: { encoding: 'base64', content: Buffer.from(contents).toString('base64') } })
    }
    gh.route('GET', `${repo}/labels`, { status: 200, body: [{ name: 'approved' }, { name: 'lgtm' }] })
  }

  function runSweep() {
    return runBundle({ eventName: 'schedule', payload: {}, inputs: { ...token, jobs: 'sweep' }, apiUrl: gh.url })
  }

  function requested() {
    return gh.requestsMatching('POST', /\/requested_reviewers$/).map(r => r.path).sort()
  }

  function timelineReads() {
    return gh.requestsMatching('GET', /\/timeline\?per_page=100$/).map(r => r.path).sort()
  }

  it('does not catch up a pull request whose review clock expired before now − delay − lookback: not listed, read or requested', async () => {
    serve('blunderbuss:\n  delay: 1h\n')

    const result = await runSweep()

    expect(result.status, result.stdout).toBe(0)
    expect(result.errors).toEqual([])
    expect(result.stdout).toContain('sweep: 0 candidates updated since')
    expect(result.stdout).toContain('sweep: 1 more checked for delayed reviewers')
    expect(requested()).toEqual([`${repo}/pulls/1/requested_reviewers`])
    expect(timelineReads()).toEqual([`${repo}/issues/1/timeline?per_page=100`])
    // one list page, nothing else about #2: the sweep never asks after it
    expect(gh.requestsMatching('GET', /\/pulls\?/).map(r => r.path)).toEqual([`${repo}/pulls?state=open&sort=updated&direction=desc&per_page=100&page=1`])
    expect(gh.requests.filter(r => /\/(?:pulls|issues)\/2(?:\/|$|\?)/.test(r.path))).toEqual([])
  })

  it('a longer sweep.lookback is what recovers it: the window reaches back to it and it gets reviewers', async () => {
    serve('blunderbuss:\n  delay: 1h\nsweep:\n  lookback: 2h\n')

    const result = await runSweep()

    expect(result.status, result.stdout).toBe(0)
    expect(result.errors).toEqual([])
    // with the plain window now [now − 2h, now], #1 is an ordinary candidate and #2 the delayed-only one
    expect(result.stdout).toContain('sweep: 1 candidate updated since')
    expect(result.stdout).toContain('sweep: 1 more checked for delayed reviewers')
    expect(requested()).toEqual([`${repo}/pulls/1/requested_reviewers`, `${repo}/pulls/2/requested_reviewers`])
    expect(timelineReads()).toEqual([`${repo}/issues/1/timeline?per_page=100`, `${repo}/issues/2/timeline?per_page=100`])
  })
})
