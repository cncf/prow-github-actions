import type { FakeGithub } from './fakeGithub'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import pullReqListPulls from '../fixtures/pullReq/pullReqListPulls.json'
import { start } from './fakeGithub'
import { configReads, helpersFor, ownersProbe, queueRead, repo, token } from './helpers'
import { runBundle } from './runBundle'

vi.setConfig({ testTimeout: 30_000 })

// queueState promises "a warning, once per run" when the merge-queue GraphQL read fails
// (src/utils/mergeQueue.ts:87). Every other bundle run reads the queue for one pull request, so the
// arm that silences the second and later failures never runs. The sweep cron evaluates every
// candidate in one process, so two lgtm'd candidates on a GHES without the queue fields drive it.
describe('dist/index.js schedule sweep job when the merge queue state read fails for every candidate', () => {
  let gh: FakeGithub
  const { calls } = helpersFor(() => gh)

  const listPage = (page: number) => `GET ${repo}/pulls?state=open&sort=updated&direction=desc&per_page=100&page=${page}`
  const bound = [{ context: 'prow/lgtm', state: 'success' }]
  const fallback = 'falling back to a direct merge'

  beforeAll(async () => {
    gh = await start()
  })
  afterEach(() => gh.reset())
  afterAll(() => gh.close())

  function runSweep() {
    return runBundle({ eventName: 'schedule', payload: {}, inputs: { ...token, jobs: 'sweep' }, apiUrl: gh.url })
  }

  function forkPr(number: number) {
    const stamp = new Date().toISOString()
    return {
      ...structuredClone(pullReqListPulls[0]),
      labels: [{ name: 'lgtm' }],
      number,
      created_at: stamp,
      updated_at: stamp,
      requested_reviewers: [],
      assignees: [],
      draft: false,
      mergeable: true,
      mergeable_state: 'clean',
      user: { login: 'dave' },
      head: { sha: `sha${number}`, repo: { full_name: 'dave/Hello-World' } },
      base: { ref: 'master', sha: 'basesha' },
    }
  }

  function routeCandidate(number: number) {
    const pr = forkPr(number)
    gh.route('GET', `${repo}/pulls/${number}`, { status: 200, body: pr })
    gh.commitStatuses(repo, `sha${number}`, bound)
    gh.route('PUT', `${repo}/pulls/${number}/merge`, { status: 200, body: { merged: true } })
    return pr
  }

  it('warns once for the run, not once per candidate, and merges every candidate directly', async () => {
    const first = routeCandidate(1)
    const second = routeCandidate(2)
    gh.route('GET', repo, { status: 200, body: { default_branch: 'master' } })
    gh.route('GET', new RegExp(`^${repo}/pulls\\?`), (req) => {
      const page = new URL(req.path, gh.url).searchParams.get('page')
      return { status: 200, body: page === '1' ? [first, second] : [] }
    })
    gh.mergeQueue({ pullRequestId: 'PR_kwDOtest', headOid: 'sha1', enabled: true, queryError: 'Field \'isMergeQueueEnabled\' doesn\'t exist on type \'PullRequest\'' })

    const result = await runSweep()

    expect(result.status, result.stdout).toBe(0)
    expect(result.errors).toEqual([])
    expect(result.stdout).toContain('sweep: 2 candidates updated since')
    expect(result.stdout).toContain('merged pr #1')
    expect(result.stdout).toContain('merged pr #2')
    expect(result.stdout).toContain('sweep: #1 merged')
    expect(result.stdout).toContain('sweep: #2 merged')
    // both state reads were attempted and both failed, but only the first to fail is reported; the candidates are
    // evaluated concurrently, so which one that is varies from run to run
    expect(gh.graphqlCalls('isMergeQueueEnabled')).toHaveLength(2)
    const warnings = result.stdout.split('\n').filter(line => line.startsWith('::warning::') && line.includes(fallback))
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toMatch(/could not read the merge queue state of pr #[12]; falling back to a direct merge/)
    expect(gh.graphqlCalls('enqueuePullRequest')).toEqual([])
    expect(gh.requestsMatching('PUT', /\/merge$/).map(r => r.path).sort()).toEqual([`${repo}/pulls/1/merge`, `${repo}/pulls/2/merge`])
    // the configuration, the window's page, the OWNERS probe once for the shared base, then per candidate: the pr,
    // its binding, the failed queue read and the direct merge — the candidates are evaluated concurrently, so the
    // two tails interleave in no fixed order
    const recorded = calls()
    const reads = configReads()
    expect(recorded.slice(0, reads.length).sort()).toEqual([...reads].sort())
    expect(recorded.slice(reads.length, reads.length + 2)).toEqual([listPage(1), ownersProbe])
    expect(recorded.slice(reads.length + 2).sort()).toEqual([
      `GET ${repo}/pulls/1`,
      `GET ${repo}/commits/sha1/status?per_page=100`,
      queueRead,
      `PUT ${repo}/pulls/1/merge`,
      `GET ${repo}/pulls/2`,
      `GET ${repo}/commits/sha2/status?per_page=100`,
      queueRead,
      `PUT ${repo}/pulls/2/merge`,
    ].sort())
  })
})
