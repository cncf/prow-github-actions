import type { FakeGithub } from './fakeGithub'
import { Buffer } from 'node:buffer'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import labelFileContents from '../fixtures/labels/labelFileContentsResp.json'
import pullReqListPulls from '../fixtures/pullReq/pullReqListPulls.json'
import { blobSha } from '../utils/ownersData'
import { start } from './fakeGithub'
import { helpersFor, repo, token } from './helpers'
import { runBundle } from './runBundle'

vi.setConfig({ testTimeout: 30_000 })

// The delayed-reviewers loop of the sweep (src/cronJobs/sweep.ts,
// `requestReviewersIfDue`) reads `requested_reviewers ?? []` and
// `requested_teams ?? []` off the pull list entry: a due pull request listed
// without either key counts as having no requested reviewers and gets them.
describe('dist/index.js delayed blunderbuss on a pull request listed without reviewer keys', () => {
  let gh: FakeGithub
  const { routeOwners } = helpersFor(() => gh)
  const owners = { OWNERS: 'reviewers:\n- bob\n' }

  beforeAll(async () => {
    gh = await start()
  })
  afterEach(() => gh.reset())
  afterAll(() => gh.close())

  function ago(minutes: number) {
    return new Date(Date.now() - minutes * 60_000).toISOString()
  }

  it('requests reviewers on a due pull request whose listing omits requested_reviewers and requested_teams', async () => {
    const file = structuredClone(labelFileContents)
    file.content = Buffer.from('blunderbuss:\n  delay: 1h\n').toString('base64')
    gh.route('GET', '/repos/Codertocat/.project/contents/prow.yaml', { status: 200, body: file })
    const { requested_reviewers: _reviewers, requested_teams: _teams, ...bare } = {
      ...structuredClone(pullReqListPulls[0]),
      number: 1,
      created_at: ago(70),
      updated_at: ago(70),
      labels: [],
      assignees: [],
      draft: false,
      user: { login: 'Codertocat' },
      base: { ref: 'master', sha: 'basesha' },
      head: { sha: 'sha1', repo: { full_name: 'Codertocat/Hello-World' } },
    }
    expect(bare).not.toHaveProperty('requested_reviewers')
    expect(bare).not.toHaveProperty('requested_teams')
    gh.route('GET', new RegExp(`^${repo}/pulls\\?`), { status: 200, body: [bare] })
    gh.route('GET', `${repo}/git/trees/master`, {
      status: 200,
      body: { sha: 'master', truncated: false, tree: [{ path: 'OWNERS', type: 'blob', sha: blobSha('OWNERS') }] },
    })
    routeOwners(owners, ['x.go'], bare)
    gh.route('GET', `${repo}/issues/1/timeline`, { status: 200, body: [] })
    gh.route('GET', `${repo}/pulls/1/reviews`, { status: 200, body: [] })
    gh.route('POST', `${repo}/pulls/1/requested_reviewers`, { status: 201, body: {} })

    const result = await runBundle({ eventName: 'schedule', payload: {}, inputs: { ...token, jobs: 'sweep' }, apiUrl: gh.url })

    expect(result.status, result.stdout).toBe(0)
    expect(result.errors).toEqual([])
    expect(result.stdout).toContain('sweep: 0 candidates updated since')
    expect(result.stdout).toContain('sweep: 1 more checked for delayed reviewers')
    expect(result.stdout).not.toContain('already has requested reviewers')
    expect(gh.requestsMatching('GET', /\/timeline\?per_page=100$/)).toHaveLength(1)
    expect(gh.requestsMatching('GET', /\/reviews\?per_page=1$/)).toHaveLength(1)
    expect(gh.requestsMatching('POST', /\/requested_reviewers$/).map(r => r.body)).toEqual([{ reviewers: ['bob'] }])
    expect(gh.requests.filter(r => r.method !== 'GET').map(r => r.path)).toEqual([`${repo}/pulls/1/requested_reviewers`])
  })
})
