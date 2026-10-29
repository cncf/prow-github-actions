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

interface Spec {
  number: number
  createdMinutesAgo: number
  updatedMinutesAgo?: number
  draft?: boolean
  author?: string
}

function pull(spec: Spec) {
  return {
    ...structuredClone(pullReqListPulls[0]),
    number: spec.number,
    draft: spec.draft ?? false,
    labels: [],
    created_at: ago(spec.createdMinutesAgo),
    updated_at: ago(spec.updatedMinutesAgo ?? spec.createdMinutesAgo),
    requested_reviewers: [],
    requested_teams: [],
    assignees: [],
    user: { login: spec.author ?? 'some-author' },
    head: { sha: `sha${spec.number}` },
    base: { ref: 'master', sha: 'basesha' },
  }
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

// Pins three guards of `requestReviewersIfDue` (src/cronJobs/sweep.ts) that
// the other delayed-blunderbuss suites reach but never distinguish: the
// `ready_for_review` filter on the timeline, the draft skip before any
// timeline read, and `explicit: false` carrying `ignore_authors` into the
// delayed path.
describe('sweep with blunderbuss.delay: guards of requestReviewersIfDue', () => {
  let context: utils.MockContext
  let requested: number[]
  let timelineReads: number[]
  let timeline: Record<number, Array<{ event?: string, created_at?: string }>>

  function servePulls(pulls: ReturnType<typeof pull>[]) {
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
    timeline = {}
    server.use(
      prowYaml('blunderbuss:\n  delay: 1h\n'),
      ...utils.noOrgOrRepoConfigExcept(),
      utils.defaultBranchTree(['OWNERS']),
      http.get(`${repo}/branches/master`, utils.mockResponse(200, { commit: { sha: 'basesha' } })),
      http.get(`${repo}/git/trees/basesha`, utils.mockResponse(200, { sha: 'basesha', truncated: false, tree: [{ path: 'OWNERS', type: 'blob', sha: blobSha('OWNERS') }] })),
      http.get(`${repo}/git/blobs/${blobSha('OWNERS')}`, utils.mockResponse(200, { encoding: 'base64', content: Buffer.from(owners).toString('base64') })),
      http.get(`${repo}/pulls/:number/files`, utils.mockResponse(200, [{ filename: 'x.go', status: 'modified' }])),
      http.get(`${repo}/pulls/:number/reviews`, utils.mockResponse(200, [])),
      http.get(`${repo}/issues/:number/timeline`, ({ params }) => {
        timelineReads.push(Number(params.number))
        return json(timeline[Number(params.number)] ?? [])
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

  it('times a former draft from its last ready_for_review, not from a later unrelated timeline event', async () => {
    // opened long before the due window, marked ready inside it, then labeled after it;
    // only the ready_for_review event moves the review clock
    servePulls([pull({ number: 1, createdMinutesAgo: 5 * 60, updatedMinutesAgo: 70 })])
    timeline[1] = [
      { event: 'ready_for_review', created_at: ago(70) },
      { event: 'labeled', created_at: ago(10) },
      { event: 'ready_for_review' },
    ]

    await expect(sweep(context)).resolves.toEqual({ candidates: [], merged: [], enqueued: [], failures: [] })
    expect(timelineReads).toEqual([1])
    expect(requested).toEqual([1])
  })

  it('leaves a draft alone before reading its timeline when ignore_drafts is on', async () => {
    servePulls([pull({ number: 1, createdMinutesAgo: 70, draft: true })])
    timeline[1] = [{ event: 'ready_for_review', created_at: ago(70) }]

    await expect(sweep(context)).resolves.toEqual({ candidates: [], merged: [], enqueued: [], failures: [] })
    expect(timelineReads).toEqual([])
    expect(requested).toEqual([])
  })

  it('leaves a due pull request by an author in blunderbuss.ignore_authors alone', async () => {
    server.use(prowYaml('blunderbuss:\n  delay: 1h\n  ignore_authors:\n  - Dave\n'))
    servePulls([
      pull({ number: 1, createdMinutesAgo: 70, author: 'dave' }),
      pull({ number: 2, createdMinutesAgo: 70, author: 'erin' }),
    ])

    await expect(sweep(context)).resolves.toEqual({ candidates: [], merged: [], enqueued: [], failures: [] })
    expect(requested).toEqual([2])
  })
})
