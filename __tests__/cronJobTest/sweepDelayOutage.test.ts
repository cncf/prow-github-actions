import { Buffer } from 'node:buffer'
import * as core from '@actions/core'
import { http } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { sweep } from '../../src/cronJobs/sweep'
import { resetOwnersCaches } from '../../src/utils/owners'
import labelFileContents from '../fixtures/labels/labelFileContentsResp.json'
import pullReqOpenedEvent from '../fixtures/pullReq/pullReqOpenedEvent.json'
import * as utils from '../testUtils'
import { blobSha, branchHandler } from '../utils/ownersFixtures'

const server = setupServer()
beforeAll(() => server.listen(utils.failOnUnhandledRequest))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

const repo = `${utils.api}/repos/Codertocat/Hello-World`
const now = new Date('2026-09-16T12:00:00Z')

function ago(minutes: number): string {
  return new Date(now.getTime() - minutes * 60_000).toISOString()
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function prowYaml(text: string) {
  const file = structuredClone(labelFileContents)
  file.content = Buffer.from(text).toString('base64')
  return http.get(utils.contentsUrl('.github/prow.yaml'), utils.mockResponse(200, file))
}

function pull(number: number, minutesAgo: number) {
  return {
    number,
    state: 'open',
    locked: false,
    draft: false,
    merged: false,
    mergeable: true,
    mergeable_state: 'clean',
    labels: [],
    created_at: ago(minutesAgo),
    updated_at: ago(minutesAgo),
    requested_reviewers: [],
    requested_teams: [],
    assignees: [],
    user: { login: 'some-author' },
    head: { sha: `sha${number}` },
    base: { ref: 'master', sha: 'basesha' },
  }
}

// The recovery expectation of the delayed-reviewers sweep (src/cronJobs/sweep.ts,
// `sweep` → `recentlyUpdatedPulls` with `due.from`) after the schedule missed runs
// for longer than `sweep.lookback`: the list stops at `now − delay − lookback`, so
// a pull request nobody touched since its review clock expired before that instant
// is neither listed, read nor requested, however due it is. There is no unbounded
// catch-up; a longer `sweep.lookback` (capped at 24h) is what widens the window.
describe('sweep with blunderbuss.delay after missed schedule runs', () => {
  const owners = { OWNERS: 'approvers:\n- alice\nreviewers:\n- carol\n' }
  let context: utils.MockContext
  let calls: string[]

  function recordCall({ request }: { request: Request }) {
    const url = new URL(request.url)
    calls.push(`${request.method} ${url.pathname}${url.search}`)
  }

  beforeEach(() => {
    utils.setupJobsEnv('sweep')
    vi.useFakeTimers({ now, toFake: ['Date'] })
    resetOwnersCaches()
    context = new utils.MockContext(pullReqOpenedEvent)
    context.eventName = 'schedule'
    calls = []
    server.events.on('request:start', recordCall)
  })

  afterEach(() => {
    server.events.removeListener('request:start', recordCall)
    vi.useRealTimers()
  })

  // #1 opened 90 minutes ago sits inside the default due window [now − 2h, now − 1h];
  // #2 opened 2.5 hours ago fell out of it while no sweep ran, and nobody touched it since
  const pulls = [pull(1, 90), pull(2, 150)]

  function serve(config: string) {
    const tree = Object.keys(owners).map(path => ({ path, type: 'blob', sha: blobSha(path) }))
    const requested: number[] = []
    const timelineReads: number[] = []
    server.use(
      prowYaml(config),
      ...utils.noOrgOrRepoConfigExcept(),
      utils.defaultBranchTree(Object.keys(owners)),
      branchHandler('basesha'),
      http.get(`${repo}/git/trees/basesha`, utils.mockResponse(200, { sha: 'basesha', truncated: false, tree })),
      ...Object.entries(owners).map(([path, contents]) => http.get(`${repo}/git/blobs/${blobSha(path)}`, utils.mockResponse(200, { encoding: 'base64', content: Buffer.from(contents).toString('base64') }))),
      http.get(`${repo}/pulls`, utils.mockResponse(200, pulls)),
      http.get(`${repo}/pulls/:number`, ({ params }) => json(pulls.find(pr => pr.number === Number(params.number)))),
      http.get(`${repo}/pulls/:number/files`, utils.mockResponse(200, [{ filename: 'x.go', status: 'modified' }])),
      http.get(`${repo}/issues/:number/timeline`, ({ params }) => {
        timelineReads.push(Number(params.number))
        return json([])
      }),
      http.get(`${repo}/pulls/:number/reviews`, utils.mockResponse(200, [])),
      // a candidate inside the plain window runs every sweep step, not only the delayed reviewers
      http.get(`${repo}/issues/:number`, utils.mockResponse(200, { labels: [] })),
      http.get(`${repo}/issues/:number/comments`, utils.mockResponse(200, [])),
      http.post(`${repo}/issues/:number/comments`, utils.mockResponse(201, {})),
      utils.repoHasLabels(['approved', 'lgtm']),
      http.post(`${repo}/pulls/:number/requested_reviewers`, ({ params }) => {
        requested.push(Number(params.number))
        return json({}, 201)
      }),
    )
    return { requested, timelineReads }
  }

  it('does not catch up a pull request whose review clock expired before now − delay − lookback: not listed, read or requested', async () => {
    const { requested, timelineReads } = serve('blunderbuss:\n  delay: 1h\n')
    const info = vi.spyOn(core, 'info')

    await expect(sweep(context)).resolves.toEqual({ candidates: [], merged: [], enqueued: [], failures: [] })

    expect(requested).toEqual([1])
    expect(timelineReads).toEqual([1])
    expect(info).toHaveBeenCalledWith(`sweep: 1 more checked for delayed reviewers, updated since ${ago(120)}`)
    // one list page, nothing else about #2: the sweep never asks after it
    expect(calls.filter(call => call.includes('/pulls?'))).toEqual([`GET /repos/Codertocat/Hello-World/pulls?state=open&sort=updated&direction=desc&per_page=100&page=1`])
    expect(calls.filter(call => /\/(?:pulls|issues)\/2(?:\/|$|\?)/.test(call))).toEqual([])
  })

  it('a longer sweep.lookback is what recovers it: the window reaches back to it and it gets reviewers', async () => {
    const { requested, timelineReads } = serve('blunderbuss:\n  delay: 1h\nsweep:\n  lookback: 2h\n')
    const info = vi.spyOn(core, 'info')

    // with the plain window now [now − 2h, now], #1 is an ordinary candidate and #2 the delayed-only one
    await expect(sweep(context)).resolves.toEqual({ candidates: [1], merged: [], enqueued: [], failures: [] })

    expect([...requested].sort()).toEqual([1, 2])
    expect([...timelineReads].sort()).toEqual([1, 2])
    expect(info).toHaveBeenCalledWith(`sweep: 1 more checked for delayed reviewers, updated since ${ago(180)}`)
  })
})
