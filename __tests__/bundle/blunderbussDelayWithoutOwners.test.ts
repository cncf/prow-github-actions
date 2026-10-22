import type { FakeGithub } from './fakeGithub'
import { Buffer } from 'node:buffer'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import labelFileContents from '../fixtures/labels/labelFileContentsResp.json'
import pullReqListPulls from '../fixtures/pullReq/pullReqListPulls.json'
import { start } from './fakeGithub'
import { repo, token } from './helpers'
import { runBundle } from './runBundle'

vi.setConfig({ testTimeout: 30_000 })

// The delayed-reviewers loop of the sweep (src/cronJobs/sweep.ts) probes the
// base branch for OWNERS files before `requestReviewersIfDue`; without any, a
// due pull request is left alone and none of blunderbuss' reads happen.
describe('dist/index.js delayed blunderbuss on a base branch without OWNERS files', () => {
  let gh: FakeGithub

  beforeAll(async () => {
    gh = await start()
  })
  afterEach(() => gh.reset())
  afterAll(() => gh.close())

  function ago(minutes: number) {
    return new Date(Date.now() - minutes * 60_000).toISOString()
  }

  it('probes the base branch once and requests no reviewers for a due pull request', async () => {
    const file = structuredClone(labelFileContents)
    file.content = Buffer.from('blunderbuss:\n  delay: 1h\n').toString('base64')
    gh.route('GET', '/repos/Codertocat/.project/contents/prow.yaml', { status: 200, body: file })
    gh.route('GET', new RegExp(`^${repo}/pulls\\?`), {
      status: 200,
      body: [{
        ...structuredClone(pullReqListPulls[0]),
        number: 1,
        created_at: ago(70),
        updated_at: ago(70),
        labels: [],
        requested_reviewers: [],
        requested_teams: [],
        assignees: [],
        draft: false,
        user: { login: 'Codertocat' },
        base: { ref: 'master', sha: 'basesha' },
        head: { sha: 'sha1', repo: { full_name: 'Codertocat/Hello-World' } },
      }],
    })
    gh.route('GET', `${repo}/git/trees/master`, { status: 200, body: { sha: 'master', truncated: false, tree: [] } })

    const result = await runBundle({ eventName: 'schedule', payload: {}, inputs: { ...token, jobs: 'sweep' }, apiUrl: gh.url })

    expect(result.status, result.stdout).toBe(0)
    expect(result.errors).toEqual([])
    expect(result.stdout).toContain('sweep: 0 candidates updated since')
    expect(result.stdout).toContain('sweep: 1 more checked for delayed reviewers')
    expect(gh.requestsMatching('GET', /\/git\/trees\/master\?recursive=true$/)).toHaveLength(1)
    expect(gh.requestsMatching('GET', /\/timeline\?/)).toEqual([])
    expect(gh.requestsMatching('GET', /\/reviews\?/)).toEqual([])
    expect(gh.requests.filter(r => r.method !== 'GET')).toEqual([])
    // nothing but the configuration probes, the pull list and the one tree read
    expect(gh.requests.map(r => r.path).filter(path => !/\/contents\//.test(path))).toEqual([
      `${repo}/pulls?state=open&sort=updated&direction=desc&per_page=100&page=1`,
      `${repo}/git/trees/master?recursive=true`,
    ])
  })
})
