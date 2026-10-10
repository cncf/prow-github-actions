import type { FakeGithub } from './fakeGithub'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import pullReqListPulls from '../fixtures/pullReq/pullReqListPulls.json'
import { blobSha } from '../utils/ownersData'
import { start } from './fakeGithub'
import { configReads, helpersFor, repo, token } from './helpers'
import { runBundle } from './runBundle'

vi.setConfig({ testTimeout: 30_000 })

// the arms of the sweep cron itself — an empty window, a failed listing, and blunderbuss's freshness guards on a
// repository with OWNERS files — driven through dist/index.js like the merge paths in bundle.test.ts
describe('dist/index.js schedule sweep job arms', () => {
  let gh: FakeGithub
  const { expectRequests, routeOwners } = helpersFor(() => gh)

  const listPage = (page: number) => `GET ${repo}/pulls?state=open&sort=updated&direction=desc&per_page=100&page=${page}`
  // blunderbuss asks for one review to learn whether anybody reviewed yet; the approve plugin pages through all of them
  const freshnessRead = `GET ${repo}/pulls/1/reviews?per_page=1`

  beforeAll(async () => {
    gh = await start()
  })
  afterEach(() => gh.reset())
  afterAll(() => gh.close())

  function runSweep() {
    return runBundle({ eventName: 'schedule', payload: {}, inputs: { ...token, jobs: 'sweep' }, apiUrl: gh.url })
  }

  function forkPr(overrides: Record<string, unknown> = {}) {
    const stamp = new Date().toISOString()
    return {
      ...structuredClone(pullReqListPulls[0]),
      number: 1,
      labels: [],
      created_at: stamp,
      updated_at: stamp,
      requested_reviewers: [],
      assignees: [],
      draft: false,
      mergeable: true,
      mergeable_state: 'clean',
      user: { login: 'dave' },
      head: { sha: 'sha1', repo: { full_name: 'dave/Hello-World' } },
      base: { ref: 'master', sha: 'basesha' },
      ...overrides,
    }
  }

  function routeList(prs: unknown[] | { status: number, body: unknown }) {
    gh.route('GET', repo, { status: 200, body: { default_branch: 'master' } })
    gh.route('GET', new RegExp(`^${repo}/pulls\\?`), (req) => {
      if (!Array.isArray(prs)) {
        return prs
      }
      const page = new URL(req.path, gh.url).searchParams.get('page')
      return { status: 200, body: page === '1' ? prs : [] }
    })
  }

  it('no open pull request updated within the window: reports 0 candidates and reads nothing else', async () => {
    routeList([])

    const result = await runSweep()

    expect(result.status, result.stdout).toBe(0)
    expect(result.errors).toEqual([])
    expect(result.stdout).toContain('sweep: 0 candidates updated since')
    // the configuration, then the window's first page, which is short: no second page and no pull request read
    expectRequests(configReads(), [listPage(1)])
  })

  it('the listing failing: the run fails naming the sweep and the listing, with no pull request read', async () => {
    routeList({ status: 500, body: { message: 'boom' } })

    const result = await runSweep()

    expect(result.status, result.stdout).toBe(1)
    expect(result.errors.some(e => e.includes('sweep: could not list the open pull requests: HttpError: boom'))).toBe(true)
    expect(result.stdout).not.toContain('candidate')
    expectRequests(configReads(), [listPage(1)])
  })

  describe('blunderbuss on a repository with OWNERS files', () => {
    const ownersFiles: Record<string, string> = { 'OWNERS': 'approvers:\n- alice\n', 'sdk/OWNERS': 'reviewers:\n- bob\n- carol\nlabels:\n- area/sdk\n' }

    // the per-pull-request reads the other sweep steps make, so each case fails only on what blunderbuss does
    function routeSweep(pr: Record<string, unknown>, reviews: unknown[] = []) {
      routeList([pr])
      gh.route('GET', `${repo}/git/trees/master`, { status: 200, body: { sha: 'master', truncated: false, tree: Object.keys(ownersFiles).map(path => ({ path, type: 'blob', sha: blobSha(path) })) } })
      routeOwners(ownersFiles, ['sdk/x.go'], pr)
      gh.route('GET', `${repo}/issues/1`, { status: 200, body: { labels: [] } })
      gh.route('GET', `${repo}/labels`, { status: 200, body: ['area/sdk', 'approved', 'lgtm'].map(name => ({ name })) })
      gh.route('POST', `${repo}/issues/1/labels`, { status: 200, body: [] })
      gh.route('GET', `${repo}/pulls/1/reviews`, { status: 200, body: reviews })
      gh.route('POST', `${repo}/pulls/1/requested_reviewers`, { status: 201, body: {} })
      gh.route('GET', `${repo}/issues/1/comments`, { status: 200, body: [] })
      gh.route('POST', `${repo}/issues/1/comments`, { status: 201, body: {} })
      gh.route('GET', '/repos/Codertocat/.project/contents/prow.yaml', { status: 404, body: { message: 'Not Found' } })
    }

    function requestedReviewers() {
      return gh.requestsMatching('POST', /\/pulls\/1\/requested_reviewers$/)
    }

    function freshnessReads() {
      return gh.requestsMatching('GET', /\/pulls\/1\/reviews\?per_page=1$/)
    }

    it('a pull request opened before the window: no reviewers requested and no reviews read', async () => {
      routeSweep(forkPr({ created_at: '2011-01-26T19:01:12Z' }))

      const result = await runSweep()

      expect(result.status, result.stdout).toBe(0)
      expect(result.errors).toEqual([])
      expect(result.stdout).toContain('sweep: #1 evaluated')
      expect(result.stdout).toContain('::debug::sweep: #1 was opened before the window; no reviewers requested')
      expect(freshnessReads()).toEqual([])
      expect(requestedReviewers()).toEqual([])
      // the OWNERS label still applied, the approval notifier still posted
      expect(gh.requestsMatching('POST', /\/issues\/1\/labels$/).map(r => r.body)).toEqual([{ labels: ['area/sdk'] }])
      expect(gh.requestsMatching('POST', /\/issues\/1\/comments$/)).toHaveLength(1)
    })

    it('a fresh draft pull request: no reviewers requested and no reviews read', async () => {
      routeSweep(forkPr({ draft: true }))

      const result = await runSweep()

      expect(result.status, result.stdout).toBe(0)
      expect(result.errors).toEqual([])
      expect(result.stdout).toContain('sweep: #1 evaluated')
      expect(result.stdout).toContain('::debug::sweep: #1 is a draft or already has requested reviewers')
      expect(freshnessReads()).toEqual([])
      expect(requestedReviewers()).toEqual([])
    })

    it('a fresh pull request somebody already reviewed: the one review is read and no reviewers are requested', async () => {
      routeSweep(forkPr(), [{ id: 7, user: { login: 'erin' }, state: 'COMMENTED' }])

      const result = await runSweep()

      expect(result.status, result.stdout).toBe(0)
      expect(result.errors).toEqual([])
      expect(result.stdout).toContain('sweep: #1 evaluated')
      expect(result.stdout).toContain('::debug::sweep: #1 already has reviews')
      expect(freshnessReads().map(r => `GET ${r.path}`)).toEqual([freshnessRead])
      expect(requestedReviewers()).toEqual([])
    })
  })
})
