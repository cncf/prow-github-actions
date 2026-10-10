import type { FakeGithub } from './fakeGithub'
import { Buffer } from 'node:buffer'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import labelFileContents from '../fixtures/labels/labelFileContentsResp.json'
import pullReqOpenedEvent from '../fixtures/pullReq/pullReqOpenedEvent.json'
import { start } from './fakeGithub'
import { helpersFor, repo, token } from './helpers'
import { runBundle } from './runBundle'

vi.setConfig({ testTimeout: 30_000 })

function yamlFile(text: string) {
  const file = structuredClone(labelFileContents)
  file.content = Buffer.from(text).toString('base64')
  return file
}

// GitHub's pull request schema lets `user`, `requested_reviewers` and `assignees` be null (a deleted account,
// a pull request nobody was asked to review or assigned to); src/utils/pullRequestOwners.ts folds each to an
// empty value, and `labels` alongside them, before any plugin reads the pull request. Every other bundle case
// serves populated fields through routeOwners, so those folds only ever ran under the unit suite's fixtures
describe('dist/index.js pull request owners: null fields on the pull request', () => {
  let gh: FakeGithub
  const { routeOwners } = helpersFor(() => gh)

  beforeAll(async () => {
    gh = await start()
  })
  afterEach(() => gh.reset())
  afterAll(() => gh.close())

  function requested() {
    return gh.requestsMatching('POST', /\/pulls\/1\/requested_reviewers$/)
  }

  it('blunderbuss treats a null author, reviewers, assignees and labels as nobody and no labels', async () => {
    // max_request_count makes blunderbuss count the folded requested_reviewers, not just spread them
    gh.route('GET', '/repos/Codertocat/.project/contents/prow.yaml', {
      status: 200,
      body: yamlFile('blunderbuss:\n  request_count: 1\n  max_request_count: 1\n'),
    })
    routeOwners({ 'sdk/OWNERS': 'reviewers:\n- bob\n' }, ['sdk/x.go'], {
      user: null,
      requested_reviewers: null,
      assignees: null,
      labels: null,
    })
    gh.route('POST', `${repo}/pulls/1/requested_reviewers`, { status: 201, body: {} })

    const result = await runBundle({ eventName: 'pull_request', payload: pullReqOpenedEvent, inputs: token, apiUrl: gh.url })

    expect(result.status, result.stdout).toBe(0)
    expect(result.errors).toEqual([])
    // nobody is excluded as author, reviewer or assignee, so bob is the one candidate; one request fits under the cap
    expect(requested().map(r => r.body)).toEqual([{ reviewers: ['bob'] }])
    expect(result.stdout).toContain('blunderbuss: requested review from bob on #1')
    expect(result.stdout).not.toContain('already has')
    // the owners-label plugin walked the same pull request with its labels folded to none
    expect(result.stdout).toContain('owners-label: no OWNERS file covering the changed files declares labels')
    expect(gh.requestsMatching('POST', /\/issues\/1\/labels$/)).toEqual([])
  })
})
