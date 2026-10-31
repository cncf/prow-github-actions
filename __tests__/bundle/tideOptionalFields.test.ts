import type { FakeGithub } from './fakeGithub'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import pullReqListPulls from '../fixtures/pullReq/pullReqListPulls.json'
import pullReqOpenedEvent from '../fixtures/pullReq/pullReqOpenedEvent.json'
import { blobSha } from '../utils/ownersData'
import { start } from './fakeGithub'
import { configReads, helpersFor, ownersProbe, queueRead, repo, token } from './helpers'
import { runBundle } from './runBundle'

vi.setConfig({ testTimeout: 30_000 })

// GitHub's pull request schema leaves `draft` optional and its compare response leaves `files` optional, and a
// listed pull request may omit `labels`; tide (src/plugins/tide.ts:258,426) and the sweep cron
// (src/cronJobs/sweep.ts:141) each fold the missing field to its empty value. Every other bundle case serves
// those fields populated, so the folds only ever ran under the unit suite
describe('dist/index.js optional pull request fields folded by tide and sweep', () => {
  let gh: FakeGithub
  const { expectRequests, routeOwners } = helpersFor(() => gh)

  beforeAll(async () => {
    gh = await start()
  })
  beforeEach(() => gh.mergeQueueFallback({ pullRequestId: 'PR_none', headOid: pullReqOpenedEvent.pull_request.head.sha, enabled: false }))
  afterEach(() => gh.reset())
  afterAll(() => gh.close())

  it('pull_request labeled lgtm: a pull request answered without a `draft` field is treated as ready and merged', async () => {
    const head = pullReqOpenedEvent.pull_request.head.sha
    const { draft: _draft, ...withoutDraft } = structuredClone(pullReqListPulls[0])
    gh.commitStatuses(repo, head, [{ context: 'prow/lgtm', state: 'success' }])
    gh.route('GET', `${repo}/pulls/1`, {
      status: 200,
      body: { ...withoutDraft, number: 1, labels: [{ name: 'lgtm' }], mergeable: true, mergeable_state: 'clean', head: { sha: head } },
    })
    gh.route('PUT', `${repo}/pulls/1/merge`, { status: 200, body: { merged: true } })

    const result = await runBundle({
      eventName: 'pull_request',
      payload: { ...pullReqOpenedEvent, action: 'labeled', label: { name: 'lgtm' } },
      inputs: { ...token, 'merge-method': 'squash' },
      apiUrl: gh.url,
    })

    expect(result.status, result.stdout).toBe(0)
    expect(result.errors).toEqual([])
    expect(result.stdout).not.toContain('not mergeable (draft)')
    expect(result.stdout).toContain('merged pr #1')
    expect(gh.requestsMatching('PUT', /\/pulls\/1\/merge$/)).toHaveLength(1)
  })

  it('schedule lgtm job, fork 403: a compare answered without `files` counts no workflow files behind, so only the pull request\'s own are named', async () => {
    const head = pullReqListPulls[0].head.sha
    const pr = {
      ...structuredClone(pullReqListPulls[0]),
      labels: [{ name: 'lgtm' }],
      head: { sha: head, repo: { full_name: 'dave/Hello-World' } },
    }
    gh.route('GET', repo, { status: 200, body: { default_branch: 'master' } })
    gh.route('GET', new RegExp(`^${repo}/pulls\\?`), (req) => {
      const page = new URL(req.path, gh.url).searchParams.get('page') ?? '1'
      return { status: 200, body: page === '1' ? [pr] : [] }
    })
    gh.route('GET', `${repo}/pulls/2`, { status: 200, body: { ...pr, mergeable: true, mergeable_state: 'clean' } })
    gh.commitStatuses(repo, head, [{ context: 'prow/lgtm', state: 'success' }])
    gh.route('PUT', `${repo}/pulls/2/merge`, { status: 403, body: { message: 'Resource not accessible by integration' } })
    gh.route('GET', `${repo}/compare/${head}...master`, { status: 200, body: { status: 'ahead', ahead_by: 1, behind_by: 0 } })
    gh.route('GET', `${repo}/pulls/2/files`, { status: 200, body: [{ filename: '.github/workflows/ci.yml', status: 'modified' }] })
    gh.route('GET', `${repo}/issues/2/comments`, { status: 200, body: [] })
    gh.route('POST', `${repo}/issues/2/comments`, { status: 201, body: {} })

    const result = await runBundle({
      eventName: 'schedule',
      payload: {},
      inputs: { ...token, 'jobs': 'lgtm', 'merge-method': 'squash' },
      apiUrl: gh.url,
    })

    expect(result.status, result.stdout).toBe(0)
    expect(result.errors).toEqual([])
    expect(result.stdout).toContain('::warning::pr #2 is a fork pull request whose merge involves workflow files (`.github/workflows/ci.yml`) that it changes; the token may not merge it')
    expect(result.stdout).not.toContain('that the branch does not contain')
    expect(result.stdout).toContain('skipping pr #2: fork pull request with workflow changes: the token may not merge it')
    expect(gh.requestsMatching('POST', /\/issues\/2\/comments$/)).toHaveLength(1)
    expectRequests(configReads(), [
      `GET ${repo}/pulls?state=open&per_page=100`,
      ownersProbe,
      `GET ${repo}/pulls/2`,
      `GET ${repo}/commits/${head}/status?per_page=100`,
      queueRead,
      `PUT ${repo}/pulls/2/merge`,
      `GET ${repo}/pulls/2`,
      `GET ${repo}/compare/${head}...master`,
      `GET ${repo}/pulls/2/files?per_page=100`,
      `GET ${repo}/issues/2/comments?per_page=100`,
      `POST ${repo}/issues/2/comments`,
    ])
  })

  it('schedule sweep job: a listed pull request without `labels` does not carry ok-to-test, so no pending run is read or approved', async () => {
    const ownersFiles: Record<string, string> = { 'OWNERS': 'approvers:\n- alice\n', 'sdk/OWNERS': 'reviewers:\n- bob\n' }
    const stamp = new Date().toISOString()
    const { labels: _labels, ...listed } = {
      ...structuredClone(pullReqListPulls[0]),
      number: 1,
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
    }
    gh.route('GET', repo, { status: 200, body: { default_branch: 'master' } })
    gh.route('GET', new RegExp(`^${repo}/pulls\\?`), (req) => {
      const page = new URL(req.path, gh.url).searchParams.get('page') ?? '1'
      return { status: 200, body: page === '1' ? [listed] : [] }
    })
    gh.route('GET', `${repo}/git/trees/master`, { status: 200, body: { sha: 'master', truncated: false, tree: Object.keys(ownersFiles).map(path => ({ path, type: 'blob', sha: blobSha(path) })) } })
    // the full pull request read still carries its (empty) labels; only the listing omitted them
    routeOwners(ownersFiles, ['sdk/x.go'], { ...listed, labels: [] })
    gh.route('GET', `${repo}/issues/1`, { status: 200, body: { labels: [] } })
    gh.route('GET', `${repo}/labels`, { status: 200, body: ['approved', 'lgtm'].map(name => ({ name })) })
    gh.route('GET', `${repo}/pulls/1/reviews`, { status: 200, body: [] })
    gh.route('POST', `${repo}/pulls/1/requested_reviewers`, { status: 201, body: {} })
    gh.route('GET', `${repo}/issues/1/comments`, { status: 200, body: [] })
    gh.route('POST', `${repo}/issues/1/comments`, { status: 201, body: {} })
    gh.route('GET', '/repos/Codertocat/.project/contents/prow.yaml', { status: 404, body: { message: 'Not Found' } })

    const result = await runBundle({ eventName: 'schedule', payload: {}, inputs: { ...token, jobs: 'sweep' }, apiUrl: gh.url })

    expect(result.status, result.stdout).toBe(0)
    expect(result.errors).toEqual([])
    expect(result.stdout).toContain('sweep: #1 evaluated')
    expect(result.stdout).toContain('::debug::sweep: #1 does not carry ok-to-test')
    expect(gh.requestsMatching('GET', /\/actions\/runs/)).toEqual([])
    expect(gh.requestsMatching('POST', /\/actions\/runs\/\d+\/approve$/)).toEqual([])
    // the rest of the sweep still ran: blunderbuss requested reviews on the fresh pull request
    expect(gh.requestsMatching('POST', /\/pulls\/1\/requested_reviewers$/)).toHaveLength(1)
  })
})
