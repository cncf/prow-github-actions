import type { FakeGithub } from './fakeGithub'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import pullReqOpenedEvent from '../fixtures/pullReq/pullReqOpenedEvent.json'
import { blobSha } from '../utils/ownersFixtures'
import { start } from './fakeGithub'
import { helpersFor, ownersProbe, ownersReads, repo, token } from './helpers'
import { runBundle } from './runBundle'

vi.setConfig({ testTimeout: 30_000 })

// the owners-label arms that stop short of a label write, driven through dist/index.js on
// `synchronize` (require-matching-label, blunderbuss and tide all skip that action, so the
// call list is the OWNERS reads, the plugin's own reads and approve's probe)
describe('dist/index.js owners-label', () => {
  const ownersFiles: Record<string, string> = {
    'OWNERS': 'reviewers:\n- alice\n',
    'sdk/OWNERS': 'reviewers:\n- bob\nlabels:\n- area/sdk\n- area/docs\n',
  }
  const ownersBlobs = [`GET ${repo}/git/blobs/${blobSha('OWNERS')}`, `GET ${repo}/git/blobs/${blobSha('sdk/OWNERS')}`].sort()
  const issueRead = `GET ${repo}/issues/1`
  const labelsRead = `GET ${repo}/labels?per_page=100`
  let gh: FakeGithub
  const { calls, routeOwners } = helpersFor(() => gh)

  beforeAll(async () => {
    gh = await start()
  })
  beforeEach(() => gh.mergeQueueFallback({ pullRequestId: 'PR_none', headOid: pullReqOpenedEvent.pull_request.head.sha, enabled: false }))
  afterEach(() => gh.reset())
  afterAll(() => gh.close())

  function synchronize() {
    return runBundle({
      eventName: 'pull_request',
      payload: { ...pullReqOpenedEvent, action: 'synchronize' },
      inputs: token,
      apiUrl: gh.url,
    })
  }

  function routeIssueLabels(...names: string[]) {
    gh.route('GET', `${repo}/issues/1`, { status: 200, body: { labels: names.map(name => ({ name })) } })
  }

  function routeRepoLabels(...names: string[]) {
    gh.route('GET', `${repo}/labels`, { status: 200, body: names.map(name => ({ name })) })
  }

  function labelPosts() {
    return gh.requestsMatching('POST', /\/issues\/1\/labels$/).map(r => r.body)
  }

  it('already carrying every declared label (compared case-insensitively): reads nothing more and writes nothing', async () => {
    routeOwners(ownersFiles, ['sdk/x.go'])
    routeIssueLabels('Area/SDK', 'AREA/docs', 'kind/bug')
    routeRepoLabels('area/sdk', 'area/docs')

    const result = await synchronize()

    expect(result.status, result.stdout).toBe(0)
    expect(result.errors).toEqual([])
    expect(labelPosts()).toEqual([])
    const recorded = calls()
    expect(recorded.slice(0, 4)).toEqual(ownersReads)
    expect(recorded.slice(4, 6).sort()).toEqual(ownersBlobs)
    // the repository's label list is never consulted once nothing is missing
    expect(recorded.slice(6)).toEqual([issueRead, ownersProbe])
  })

  it('declared labels the repository does not have: logs each skip and writes nothing', async () => {
    routeOwners(ownersFiles, ['sdk/x.go'])
    routeIssueLabels()
    routeRepoLabels('kind/bug')

    const result = await synchronize()

    expect(result.status, result.stdout).toBe(0)
    expect(result.errors).toEqual([])
    expect(labelPosts()).toEqual([])
    expect(result.stdout).toContain(`owners-label: skipping label area/sdk declared in OWNERS: repository doesn't have it (run label-sync)`)
    expect(result.stdout).toContain(`owners-label: skipping label area/docs declared in OWNERS: repository doesn't have it (run label-sync)`)
    expect(calls().slice(6)).toEqual([issueRead, labelsRead, ownersProbe])
  })

  it('a failing repository label list fails the run with the cause and still lets the later handlers run', async () => {
    routeOwners(ownersFiles, ['sdk/x.go'])
    routeIssueLabels()
    gh.route('GET', `${repo}/labels`, { status: 500, body: { message: 'boom' } })

    const result = await synchronize()

    expect(result.status, result.stdout).toBe(1)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toMatch(/^error handling pull_request event: could not list the repository labels: /)
    expect(result.errors[0]).toContain('boom')
    expect(labelPosts()).toEqual([])
    // approve's default-branch probe follows regardless: the handlers run in order and the rejections are collected
    expect(calls().slice(6)).toEqual([issueRead, labelsRead, ownersProbe])
  })

  it('a pull_request payload without a pull request fails the run naming the payload', async () => {
    const { pull_request: _pr, ...withoutPullRequest } = pullReqOpenedEvent

    const result = await runBundle({
      eventName: 'pull_request',
      payload: { ...withoutPullRequest, action: 'synchronize' },
      inputs: token,
      apiUrl: gh.url,
    })

    expect(result.status, result.stdout).toBe(1)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toContain('error handling pull_request event: ')
    expect(result.errors[0]).toContain('github context payload missing pull request: ')
    expect(calls()).toEqual([])
  })
})
