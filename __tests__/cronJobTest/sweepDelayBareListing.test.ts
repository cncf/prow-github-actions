import { Buffer } from 'node:buffer'
import { http } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { sweep } from '../../src/cronJobs/sweep'
import { resetOwnersCaches } from '../../src/utils/owners'
import labelFileContents from '../fixtures/labels/labelFileContentsResp.json'
import pullReqListPulls from '../fixtures/pullReq/pullReqListPulls.json'
import pullReqOpenedEvent from '../fixtures/pullReq/pullReqOpenedEvent.json'
import * as utils from '../testUtils'
import { blobSha } from '../utils/ownersFixtures'

const server = setupServer()
beforeAll(() => server.listen(utils.failOnUnhandledRequest))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

const repo = `${utils.api}/repos/Codertocat/Hello-World`
const now = new Date('2026-09-16T12:00:00Z')

function ago(minutes: number): string {
  return new Date(now.getTime() - minutes * 60_000).toISOString()
}

function prowYaml(text: string) {
  const file = structuredClone(labelFileContents)
  file.content = Buffer.from(text).toString('base64')
  return http.get(utils.contentsUrl('.github/prow.yaml'), utils.mockResponse(200, file))
}

// Covers the `requested_reviewers ?? []` and `requested_teams ?? []` fallbacks
// of `requestReviewersIfDue` (src/cronJobs/sweep.ts): a delayed-only pull
// request whose list entry carries neither key is treated as having no
// requested reviewers, so a due one still gets blunderbuss' reviewers.
describe('sweep with blunderbuss.delay on a pull request listed without reviewer keys', () => {
  const owners = { OWNERS: 'approvers:\n- alice\nreviewers:\n- carol\n' }
  let context: utils.MockContext

  beforeEach(() => {
    utils.setupJobsEnv('sweep')
    vi.useFakeTimers({ now, toFake: ['Date'] })
    resetOwnersCaches()
    context = new utils.MockContext(pullReqOpenedEvent)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('requests reviewers on a due pull request whose listing omits requested_reviewers and requested_teams', async () => {
    const tree = Object.keys(owners).map(path => ({ path, type: 'blob', sha: blobSha(path) }))
    const timeline = new utils.ObserveRequest()
    const reviews = new utils.ObserveRequest()
    const requested = new utils.ObserveRequest()
    const { requested_reviewers: _reviewers, requested_teams: _teams, ...bare } = {
      ...structuredClone(pullReqListPulls[0]),
      number: 1,
      draft: false,
      labels: [],
      created_at: ago(70),
      updated_at: ago(70),
      assignees: [],
      user: { login: 'some-author' },
      head: { sha: 'sha1' },
      base: { ref: 'master', sha: 'basesha' },
    }
    expect(bare).not.toHaveProperty('requested_reviewers')
    expect(bare).not.toHaveProperty('requested_teams')
    server.use(
      prowYaml('blunderbuss:\n  delay: 1h\n'),
      ...utils.noOrgOrRepoConfigExcept(),
      utils.defaultBranchTree(Object.keys(owners)),
      http.get(`${repo}/git/trees/basesha`, utils.mockResponse(200, { sha: 'basesha', truncated: false, tree })),
      ...Object.entries(owners).map(([path, contents]) => http.get(`${repo}/git/blobs/${blobSha(path)}`, utils.mockResponse(200, { encoding: 'base64', content: Buffer.from(contents).toString('base64') }))),
      http.get(`${repo}/pulls`, utils.mockResponse(200, [bare])),
      http.get(`${repo}/pulls/1`, utils.mockResponse(200, bare)),
      http.get(`${repo}/pulls/1/files`, utils.mockResponse(200, [{ filename: 'x.go', status: 'modified' }])),
      http.get(`${repo}/issues/1/timeline`, utils.mockResponse(200, [], timeline)),
      http.get(`${repo}/pulls/1/reviews`, utils.mockResponse(200, [], reviews)),
      http.post(`${repo}/pulls/1/requested_reviewers`, utils.mockResponse(201, {}, requested)),
    )

    await expect(sweep(context)).resolves.toEqual({ candidates: [], merged: [], enqueued: [], failures: [] })
    await expect(timeline.called()).resolves.toBe('called')
    await expect(reviews.called()).resolves.toBe('called')
    await expect(requested.called()).resolves.toBe('called')
  })
})
