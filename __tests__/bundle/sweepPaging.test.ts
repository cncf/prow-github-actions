import type { FakeGithub } from './fakeGithub'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import pullReqListPulls from '../fixtures/pullReq/pullReqListPulls.json'
import { start } from './fakeGithub'
import { configReads, repo, token } from './helpers'
import { runBundle } from './runBundle'

vi.setConfig({ testTimeout: 30_000 })

// the paging arms of sweep.ts recentlyUpdatedPulls — a full page (per_page=100) decides from its oldest item
// whether to ask for the next page — driven through dist/index.js; sweepArms.test.ts only ever serves short pages
describe('dist/index.js schedule sweep job listing pages', () => {
  let gh: FakeGithub

  const pageSize = 100
  const hour = 60 * 60 * 1_000
  const listPage = (page: number) => `GET ${repo}/pulls?state=open&sort=updated&direction=desc&per_page=${pageSize}&page=${page}`

  beforeAll(async () => {
    gh = await start()
  })
  afterEach(() => gh.reset())
  afterAll(() => gh.close())

  function runSweep() {
    return runBundle({ eventName: 'schedule', payload: {}, inputs: { ...token, jobs: 'sweep' }, apiUrl: gh.url })
  }

  // an open pull request last updated `agoMs` ago, with nothing on it for the sweep steps to act on
  function pr(number: number, agoMs: number) {
    const stamp = new Date(Date.now() - agoMs).toISOString()
    return {
      ...structuredClone(pullReqListPulls[0]),
      number,
      labels: [],
      created_at: '2011-01-26T19:01:12Z',
      updated_at: stamp,
      requested_reviewers: [],
      assignees: [],
      draft: false,
      user: { login: 'dave' },
      head: { sha: `sha${number}`, repo: { full_name: 'dave/Hello-World' } },
      base: { ref: 'master', sha: 'basesha' },
    }
  }

  // serves the listing newest first, `pageSize` per page, and each pull request by number
  function routeList(pulls: ReturnType<typeof pr>[]) {
    gh.route('GET', repo, { status: 200, body: { default_branch: 'master' } })
    gh.route('GET', new RegExp(`^${repo}/pulls\\?`), (req) => {
      const page = Number(new URL(req.path, gh.url).searchParams.get('page'))
      return { status: 200, body: pulls.slice((page - 1) * pageSize, page * pageSize) }
    })
    gh.route('GET', new RegExp(`^${repo}/pulls/\\d+$`), (req) => {
      const number = Number(req.path.slice(req.path.lastIndexOf('/') + 1))
      return { status: 200, body: pulls.find(p => p.number === number) }
    })
    gh.route('GET', `${repo}/git/trees/master`, { status: 200, body: { sha: 'master', truncated: false, tree: [] } })
  }

  function listCalls() {
    return gh.requestsMatching('GET', /\/pulls\?/).map(r => `GET ${r.path}`)
  }

  it('a full first page whose oldest pull request predates the window: no second page is asked for', async () => {
    // the default 1h lookback: 98 inside the window, the last two outside it
    const pulls = Array.from({ length: pageSize }, (_, i) => pr(i + 1, i < 98 ? 1_000 * (i + 1) : 48 * hour + 1_000 * i))
    routeList(pulls)

    const result = await runSweep()

    expect(result.status, result.stdout).toBe(0)
    expect(result.errors).toEqual([])
    expect(result.stdout).toContain('sweep: 98 candidates updated since')
    expect(result.stdout).not.toContain('sweep: #99 evaluated')
    expect(result.stdout).not.toContain('sweep: #100 evaluated')
    expect(listCalls()).toEqual([listPage(1)])
  })

  it('a full first page still inside the window: the second, short page is asked for and ends the listing', async () => {
    const pulls = Array.from({ length: pageSize + 1 }, (_, i) => pr(i + 1, 1_000 * (i + 1)))
    routeList(pulls)

    const result = await runSweep()

    expect(result.status, result.stdout).toBe(0)
    expect(result.errors).toEqual([])
    expect(result.stdout).toContain('sweep: 101 candidates updated since')
    expect(result.stdout).toContain('sweep: #101 evaluated')
    expect(listCalls()).toEqual([listPage(1), listPage(2)])
    // the configuration, then both pages, before any pull request is read
    const reads = configReads()
    const calls = gh.requests.map(r => `${r.method} ${r.path}`)
    expect(calls.slice(0, reads.length).sort()).toEqual([...reads].sort())
    expect(calls.slice(reads.length, reads.length + 2)).toEqual([listPage(1), listPage(2)])
  })
})
