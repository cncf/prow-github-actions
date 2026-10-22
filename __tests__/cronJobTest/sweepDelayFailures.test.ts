import { Buffer } from 'node:buffer'
import { http } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { sweep } from '../../src/cronJobs/sweep'
import * as blunderbuss from '../../src/plugins/blunderbuss'
import { resetOwnersCaches } from '../../src/utils/owners'
import labelFileContents from '../fixtures/labels/labelFileContentsResp.json'
import pullReqListPulls from '../fixtures/pullReq/pullReqListPulls.json'
import pullReqOpenedEvent from '../fixtures/pullReq/pullReqOpenedEvent.json'
import * as utils from '../testUtils'
import { blobSha } from '../utils/ownersFixtures'

vi.mock('../../src/plugins/blunderbuss', { spy: true })

const server = setupServer()
beforeAll(() => server.listen(utils.failOnUnhandledRequest))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

const repo = `${utils.api}/repos/Codertocat/Hello-World`
const now = new Date('2026-09-16T12:00:00Z')
const owners = 'approvers:\n- alice\nreviewers:\n- carol\n'

function ago(minutes: number): string {
  return new Date(now.getTime() - minutes * 60_000).toISOString()
}

function prowYaml(text: string) {
  const file = structuredClone(labelFileContents)
  file.content = Buffer.from(text).toString('base64')
  return http.get(utils.contentsUrl('.github/prow.yaml'), utils.mockResponse(200, file))
}

function due(number: number) {
  return {
    ...structuredClone(pullReqListPulls[0]),
    number,
    draft: false,
    labels: [],
    created_at: ago(70),
    updated_at: ago(70),
    requested_reviewers: [],
    requested_teams: [],
    assignees: [],
    user: { login: 'some-author' },
    head: { sha: `sha${number}` },
    base: { ref: 'master', sha: 'basesha' },
  }
}

// Covers the `catch` of the delayed-reviewers loop in `sweep`
// (src/cronJobs/sweep.ts): a failure while deciding or requesting reviewers
// for one delayed pull request is recorded as a `blunderbuss:` failure of that
// pull request, in its Error and non-Error shapes, and does not stop the loop.
describe('sweep with blunderbuss.delay when one delayed pull request fails', () => {
  let context: utils.MockContext

  beforeEach(() => {
    utils.setupJobsEnv('sweep')
    vi.useFakeTimers({ now, toFake: ['Date'] })
    resetOwnersCaches()
    context = new utils.MockContext(pullReqOpenedEvent)
    server.use(
      prowYaml('blunderbuss:\n  delay: 1h\n'),
      ...utils.noOrgOrRepoConfigExcept(),
      utils.defaultBranchTree(['OWNERS']),
      http.get(`${repo}/branches/master`, utils.mockResponse(200, { commit: { sha: 'basesha' } })),
      http.get(`${repo}/git/trees/basesha`, utils.mockResponse(200, { sha: 'basesha', truncated: false, tree: [{ path: 'OWNERS', type: 'blob', sha: blobSha('OWNERS') }] })),
      http.get(`${repo}/git/blobs/${blobSha('OWNERS')}`, utils.mockResponse(200, { encoding: 'base64', content: Buffer.from(owners).toString('base64') })),
      http.get(`${repo}/pulls`, utils.mockResponse(200, [due(1), due(2)])),
      http.get(`${repo}/pulls/:number`, ({ params }) => new Response(JSON.stringify(due(Number(params.number))), { status: 200, headers: { 'Content-Type': 'application/json' } })),
      http.get(`${repo}/pulls/:number/files`, utils.mockResponse(200, [{ filename: 'x.go', status: 'modified' }])),
      http.get(`${repo}/issues/:number/timeline`, utils.mockResponse(200, [])),
      http.get(`${repo}/issues/:number`, utils.mockResponse(200, { labels: [] })),
      http.get(`${repo}/issues/:number/comments`, utils.mockResponse(200, [])),
      http.post(`${repo}/issues/:number/comments`, utils.mockResponse(201, {})),
      utils.repoHasLabels(['approved', 'lgtm']),
    )
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('records a failed review read as that pull request\'s failure and still serves the other', async () => {
    const requested: number[] = []
    server.use(
      http.get(`${repo}/pulls/1/reviews`, utils.mockResponse(500, { message: 'reviews unavailable' })),
      http.get(`${repo}/pulls/2/reviews`, utils.mockResponse(200, [])),
      http.post(`${repo}/pulls/:number/requested_reviewers`, ({ params }) => {
        requested.push(Number(params.number))
        return new Response('{}', { status: 201, headers: { 'Content-Type': 'application/json' } })
      }),
    )

    await expect(sweep(context)).rejects.toThrow('sweep: 1 pull request(s) failed: #1 (blunderbuss: reviews unavailable)')
    expect(requested).toEqual([2])
  })

  it('stringifies a non-Error rejection while requesting reviewers', async () => {
    const requested = new utils.ObserveRequest()
    server.use(
      http.get(`${repo}/pulls/:number/reviews`, utils.mockResponse(200, [])),
      http.post(`${repo}/pulls/:number/requested_reviewers`, utils.mockResponse(201, {}, requested)),
    )
    vi.mocked(blunderbuss.requestOwnersReviewers).mockRejectedValueOnce('secondary rate limit')

    await expect(sweep(context)).rejects.toThrow(/^sweep: 1 pull request\(s\) failed: #[12] \(blunderbuss: secondary rate limit\)$/)
    // the rejection was the first of the two due pull requests; the other was still requested
    await expect(requested.called()).resolves.toBe('called')
    expect(blunderbuss.requestOwnersReviewers).toHaveBeenCalledTimes(2)
  })
})
