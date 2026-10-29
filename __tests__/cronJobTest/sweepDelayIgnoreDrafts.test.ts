import { Buffer } from 'node:buffer'
import { http } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { sweep } from '../../src/cronJobs/sweep'
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
const owners = 'approvers:\n- alice\nreviewers:\n- carol\n'

function ago(minutes: number): string {
  return new Date(now.getTime() - minutes * 60_000).toISOString()
}

function prowYaml(text: string) {
  const file = structuredClone(labelFileContents)
  file.content = Buffer.from(text).toString('base64')
  return http.get(utils.contentsUrl('.github/prow.yaml'), utils.mockResponse(200, file))
}

function draft(number: number, openedMinutesAgo: number) {
  return {
    ...structuredClone(pullReqListPulls[0]),
    number,
    draft: true,
    labels: [],
    created_at: ago(openedMinutesAgo),
    updated_at: ago(openedMinutesAgo),
    requested_reviewers: [],
    requested_teams: [],
    assignees: [],
    user: { login: 'some-author' },
    head: { sha: `sha${number}` },
    base: { ref: 'master', sha: 'basesha' },
  }
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

// Covers the `ignore_drafts` false arm of `requestReviewersIfDue`
// (src/cronJobs/sweep.ts): with `blunderbuss.ignore_drafts: false` a delayed
// sweep does not skip drafts and times every pull request from `created_at`
// alone, so it never reads the timeline for a `ready_for_review` event. The
// e2e suite drives this through the bundle; this pins it per request.
describe('sweep with blunderbuss.delay and ignore_drafts off', () => {
  let context: utils.MockContext
  let requested: number[]
  let timelineReads: number[]

  function servePulls(pulls: ReturnType<typeof draft>[]) {
    server.use(
      http.get(`${repo}/pulls`, utils.mockResponse(200, pulls)),
      http.get(`${repo}/pulls/:number`, ({ params }) => {
        const item = pulls.find(pr => pr.number === Number(params.number))
        return json(item ?? { message: 'Not Found' }, item ? 200 : 404)
      }),
    )
  }

  beforeEach(() => {
    utils.setupJobsEnv('sweep')
    vi.useFakeTimers({ now, toFake: ['Date'] })
    utils.newRun()
    context = new utils.MockContext(pullReqOpenedEvent)
    requested = []
    timelineReads = []
    server.use(
      prowYaml('blunderbuss:\n  delay: 1h\n  ignore_drafts: false\n'),
      ...utils.noOrgOrRepoConfigExcept(),
      utils.defaultBranchTree(['OWNERS']),
      http.get(`${repo}/branches/master`, utils.mockResponse(200, { commit: { sha: 'basesha' } })),
      http.get(`${repo}/git/trees/basesha`, utils.mockResponse(200, { sha: 'basesha', truncated: false, tree: [{ path: 'OWNERS', type: 'blob', sha: blobSha('OWNERS') }] })),
      http.get(`${repo}/git/blobs/${blobSha('OWNERS')}`, utils.mockResponse(200, { encoding: 'base64', content: Buffer.from(owners).toString('base64') })),
      http.get(`${repo}/pulls/:number/files`, utils.mockResponse(200, [{ filename: 'x.go', status: 'modified' }])),
      http.get(`${repo}/pulls/:number/reviews`, utils.mockResponse(200, [])),
      http.get(`${repo}/issues/:number/timeline`, ({ params }) => {
        timelineReads.push(Number(params.number))
        return json([{ event: 'ready_for_review', created_at: ago(5) }])
      }),
      http.get(`${repo}/issues/:number`, utils.mockResponse(200, { labels: [] })),
      http.get(`${repo}/issues/:number/comments`, utils.mockResponse(200, [])),
      http.post(`${repo}/issues/:number/comments`, utils.mockResponse(201, {})),
      http.post(`${repo}/pulls/:number/requested_reviewers`, ({ params }) => {
        requested.push(Number(params.number))
        return json({}, 201)
      }),
      utils.repoHasLabels(['approved', 'lgtm']),
    )
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('requests reviewers on a due draft from its creation time without reading the timeline', async () => {
    // the timeline would say the draft became ready 5 minutes ago, which is not consulted
    servePulls([draft(1, 70)])

    await expect(sweep(context)).resolves.toEqual({ candidates: [], merged: [], enqueued: [], failures: [] })
    expect(requested).toEqual([1])
    expect(timelineReads).toEqual([])
  })

  it('still leaves alone a draft opened after the due window', async () => {
    servePulls([draft(1, 30), draft(2, 70)])

    // #1 was updated inside the lookback, so it is a tide candidate, but it is not due for reviewers yet
    await expect(sweep(context)).resolves.toEqual({ candidates: [1], merged: [], enqueued: [], failures: [] })
    expect(requested).toEqual([2])
    expect(timelineReads).toEqual([])
  })
})
