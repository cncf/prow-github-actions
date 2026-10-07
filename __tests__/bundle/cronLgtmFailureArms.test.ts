import type { FakeGithub } from './fakeGithub'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import pullReqListPulls from '../fixtures/pullReq/pullReqListPulls.json'
import { start } from './fakeGithub'
import { configReads, helpersFor, ownersProbe, queueRead, repo, token } from './helpers'
import { runBundle } from './runBundle'

vi.setConfig({ testTimeout: 30_000 })

// the arms of src/cronJobs/lgtm.ts that the schedule lgtm job cases in bundle.test.ts do not reach: a listing
// that cannot be read, a closed pull request in the page, and a pull request whose evaluation throws
describe('dist/index.js schedule lgtm job failure arms', () => {
  const page1 = `GET ${repo}/pulls?state=open&page=1`
  const page2 = `GET ${repo}/pulls?state=open&page=2`
  const head = pullReqListPulls[0].head.sha
  let gh: FakeGithub
  const { expectRequests } = helpersFor(() => gh)

  beforeAll(async () => {
    gh = await start()
  })
  afterEach(() => gh.reset())
  afterAll(() => gh.close())

  function openPr(labels: string[], overrides: Record<string, unknown> = {}) {
    const pr = structuredClone(pullReqListPulls[0])
    return { ...pr, labels: labels.map(name => ({ name })), ...overrides }
  }

  function routePage(prs: Record<string, unknown>[]) {
    gh.route('GET', new RegExp(`^${repo}/pulls\\?`), (req) => {
      const page = new URL(req.path, gh.url).searchParams.get('page')
      return { status: 200, body: page === '1' ? prs : [] }
    })
  }

  function runCron() {
    return runBundle({
      eventName: 'schedule',
      payload: {},
      inputs: { ...token, 'jobs': 'lgtm', 'merge-method': 'squash' },
      apiUrl: gh.url,
    })
  }

  it('fails the run when the open pull request listing cannot be read, before any other call', async () => {
    gh.route('GET', new RegExp(`^${repo}/pulls\\?`), { status: 500, body: { message: 'Internal Server Error' } })

    const result = await runCron()

    expect(result.status, result.stdout).toBe(1)
    expect(result.errors.some(e => e.includes('error handling cron job: Error: could not get PRs: HttpError: Internal Server Error'))).toBe(true)
    expect(gh.requestsMatching('PUT', /./)).toEqual([])
    expectRequests(configReads(), [page1])
  })

  it('skips a closed pull request in the listing without reading it, and still merges its open sibling', async () => {
    routePage([openPr(['lgtm'], { number: 3, state: 'closed' }), openPr(['lgtm'])])
    gh.route('GET', `${repo}/pulls/2`, { status: 200, body: { ...openPr(['lgtm']), mergeable: true, mergeable_state: 'clean' } })
    gh.commitStatuses(repo, head, [{ context: 'prow/lgtm', state: 'success' }])
    gh.route('PUT', `${repo}/pulls/2/merge`, { status: 200, body: { merged: true } })

    const result = await runCron()

    expect(result.status, result.stdout).toBe(0)
    expect(result.errors).toEqual([])
    expect(result.stdout).toContain('processing pr: 3')
    expect(result.stdout).toContain('merged pr #2')
    expect(gh.requestsMatching('GET', /\/pulls\/3/)).toEqual([])
    const merges = gh.requestsMatching('PUT', /\/pulls\/\d+\/merge$/)
    expect(merges).toHaveLength(1)
    expect(merges[0].body).toEqual({ merge_method: 'squash', sha: head })
    // the closed pr is dropped before its base's gate is resolved: the tree is probed for #2 only
    expectRequests(configReads(), [
      page1,
      ownersProbe,
      `GET ${repo}/pulls/2`,
      `GET ${repo}/commits/${head}/status?per_page=100`,
      queueRead,
      `PUT ${repo}/pulls/2/merge`,
      page2,
    ])
  })

  it('fails the run when a listed pull request cannot be re-read for evaluation, and stops paging', async () => {
    routePage([openPr(['lgtm'])])
    gh.route('GET', `${repo}/pulls/2`, { status: 500, body: { message: 'Internal Server Error' } })

    const result = await runCron()

    expect(result.status, result.stdout).toBe(1)
    expect(result.errors.some(e => e.includes('error handling cron job: TypeError: error processing pr: HttpError: Internal Server Error'))).toBe(true)
    expect(gh.requestsMatching('PUT', /./)).toEqual([])
    expectRequests(configReads(), [page1, ownersProbe, `GET ${repo}/pulls/2`])
  })
})
