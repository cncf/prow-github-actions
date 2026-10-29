import { Buffer } from 'node:buffer'
import { http } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { sweep } from '../../src/cronJobs/sweep'
import labelFileContents from '../fixtures/labels/labelFileContentsResp.json'
import pullReqListPulls from '../fixtures/pullReq/pullReqListPulls.json'
import pullReqOpenedEvent from '../fixtures/pullReq/pullReqOpenedEvent.json'
import * as utils from '../testUtils'

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

// Covers the delayed-reviewers loop of `sweep` (src/cronJobs/sweep.ts, the
// `branchHasOwners` guard ahead of `requestReviewersIfDue`) on a base branch
// without OWNERS files: the only pull requests in scope are the delayed ones,
// so the skip is observable as the absence of every blunderbuss read and write.
describe('sweep with blunderbuss.delay on a base branch without OWNERS files', () => {
  let context: utils.MockContext

  beforeEach(() => {
    utils.setupJobsEnv('sweep')
    vi.useFakeTimers({ now, toFake: ['Date'] })
    utils.newRun()
    context = new utils.MockContext(pullReqOpenedEvent)
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('probes the base branch once and requests no reviewers for a due pull request', async () => {
    const tree = new utils.ObserveRequest()
    const timeline = new utils.ObserveRequest()
    const reviews = new utils.ObserveRequest()
    const requested = new utils.ObserveRequest()
    const due = {
      ...structuredClone(pullReqListPulls[0]),
      number: 1,
      draft: false,
      labels: [],
      created_at: ago(70),
      updated_at: ago(70),
      requested_reviewers: [],
      requested_teams: [],
      assignees: [],
      user: { login: 'some-author' },
      head: { sha: 'sha1' },
      base: { ref: 'master', sha: 'basesha' },
    }
    server.use(
      prowYaml('blunderbuss:\n  delay: 1h\n'),
      ...utils.noOrgOrRepoConfigExcept(),
      utils.defaultBranchTree([], tree),
      http.get(`${repo}/pulls`, utils.mockResponse(200, [due])),
      http.get(`${repo}/issues/1/timeline`, utils.mockResponse(200, [], timeline)),
      http.get(`${repo}/pulls/1/reviews`, utils.mockResponse(200, [], reviews)),
      http.post(`${repo}/pulls/1/requested_reviewers`, utils.mockResponse(201, {}, requested)),
    )

    await expect(sweep(context)).resolves.toEqual({ candidates: [], merged: [], enqueued: [], failures: [] })
    await expect(tree.called()).resolves.toBe('called')
    await expect(timeline.notCalled()).resolves.toBe('not called')
    await expect(reviews.notCalled()).resolves.toBe('not called')
    await expect(requested.notCalled()).resolves.toBe('not called')
  })
})
