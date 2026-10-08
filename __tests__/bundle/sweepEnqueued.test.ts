import type { FakeGithub } from './fakeGithub'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import pullReqListPulls from '../fixtures/pullReq/pullReqListPulls.json'
import { start } from './fakeGithub'
import { configReads, helpersFor, ownersProbe, queueRead, repo, token } from './helpers'
import { runBundle } from './runBundle'

vi.setConfig({ testTimeout: 30_000 })

// the sweep cron's `enqueued` outcome, driven through dist/index.js: on a base branch that requires a merge queue,
// a candidate that passes the gate is added to the queue instead of merged, and the sweep reports it as enqueued
describe('dist/index.js schedule sweep job on a merge queue branch', () => {
  let gh: FakeGithub
  const { expectRequests } = helpersFor(() => gh)

  const listPage = (page: number) => `GET ${repo}/pulls?state=open&sort=updated&direction=desc&per_page=100&page=${page}`
  const bound = [{ context: 'prow/lgtm', state: 'success' }]
  const nodeId = 'PR_kwDOtest'

  beforeAll(async () => {
    gh = await start()
  })
  afterEach(() => gh.reset())
  afterAll(() => gh.close())

  function runSweep() {
    return runBundle({ eventName: 'schedule', payload: {}, inputs: { ...token, jobs: 'sweep' }, apiUrl: gh.url })
  }

  function forkPr(number: number, labels: string[], overrides: Record<string, unknown> = {}) {
    const stamp = new Date().toISOString()
    return {
      ...structuredClone(pullReqListPulls[0]),
      labels: labels.map(name => ({ name })),
      number,
      created_at: stamp,
      updated_at: stamp,
      requested_reviewers: [],
      assignees: [],
      draft: false,
      mergeable: true,
      mergeable_state: 'blocked',
      user: { login: 'dave' },
      head: { sha: `sha${number}`, repo: { full_name: 'dave/Hello-World' } },
      base: { ref: 'master', sha: 'basesha' },
      ...overrides,
    }
  }

  function routeList(prs: unknown[]) {
    gh.route('GET', repo, { status: 200, body: { default_branch: 'master' } })
    gh.route('GET', new RegExp(`^${repo}/pulls\\?`), (req) => {
      const page = new URL(req.path, gh.url).searchParams.get('page')
      return { status: 200, body: page === '1' ? prs : [] }
    })
  }

  it('a candidate with a bound lgtm is enqueued pinned to its head, reported as enqueued, and never PUT-merged', async () => {
    const pr = forkPr(1, ['lgtm'])
    routeList([pr])
    gh.route('GET', `${repo}/pulls/1`, { status: 200, body: pr })
    gh.commitStatuses(repo, 'sha1', bound)
    gh.route('PUT', `${repo}/pulls/1/merge`, { status: 405, body: { message: 'Changes must be made through the merge queue.' } })
    gh.mergeQueue({ pullRequestId: nodeId, headOid: 'sha1', enabled: true })

    const result = await runSweep()

    expect(result.status, result.stdout).toBe(0)
    expect(result.errors).toEqual([])
    expect(result.stdout).toContain('sweep: 1 candidate updated since')
    expect(result.stdout).toContain('enqueued pr #1 (position 1)')
    expect(result.stdout).toContain('sweep: #1 enqueued')
    expect(result.stdout).not.toContain('sweep: #1 merged')
    expect(gh.requestsMatching('PUT', /./)).toEqual([])
    const enqueues = gh.graphqlCalls('enqueuePullRequest')
    expect(enqueues).toHaveLength(1)
    expect((enqueues[0].body as { variables: unknown }).variables).toEqual({ pullRequestId: nodeId, expectedHeadOid: 'sha1' })
    // the configuration, the window's page, then for the candidate: the OWNERS probe of its base branch, the pr,
    // its binding, the queue state, then the enqueue mutation in place of the merge
    expectRequests(configReads(), [
      listPage(1),
      ownersProbe,
      `GET ${repo}/pulls/1`,
      `GET ${repo}/commits/sha1/status?per_page=100`,
      queueRead,
      queueRead,
    ])
  })

  it('an enqueued candidate is still reported when another candidate fails; the run fails listing only the failure', async () => {
    const one = forkPr(1, ['lgtm'])
    const two = forkPr(2, ['lgtm'])
    routeList([one, two])
    gh.route('GET', `${repo}/pulls/1`, { status: 200, body: one })
    gh.route('GET', `${repo}/pulls/2`, { status: 200, body: two })
    gh.commitStatuses(repo, 'sha1', bound)
    gh.commitStatuses(repo, 'sha2', bound)
    // the state query answers for whichever pull request asks; the enqueue is refused for the second one
    gh.route('POST', '/graphql', (req) => {
      const { query, variables } = req.body as { query: string, variables: { pullRequestId?: string, expectedHeadOid?: string, number?: number } }
      if (query.includes('enqueuePullRequest')) {
        return variables.expectedHeadOid === 'sha1'
          ? { status: 200, body: { data: { enqueuePullRequest: { mergeQueueEntry: { state: 'QUEUED', position: 1 } } } } }
          : { status: 200, body: { data: null, errors: [{ message: 'Resource not accessible by integration' }] } }
      }
      const number = variables.number
      return { status: 200, body: { data: { repository: { pullRequest: {
        id: `${nodeId}${number}`,
        headRefOid: `sha${number}`,
        isMergeQueueEnabled: true,
        isInMergeQueue: false,
        mergeQueueEntry: null,
      } } } } }
    })

    const result = await runSweep()

    expect(result.status, result.stdout).toBe(1)
    expect(result.stdout).toContain('sweep: #1 enqueued')
    expect(result.stdout).toContain('sweep: #2 evaluated with 1 error(s)')
    expect(result.errors.some(e => e.includes('sweep: 1 pull request(s) failed: #2 (tide: cannot add pr #2 to the merge queue'))).toBe(true)
    expect(gh.requestsMatching('PUT', /./)).toEqual([])
    expect(gh.graphqlCalls('enqueuePullRequest')).toHaveLength(2)
  })
})
