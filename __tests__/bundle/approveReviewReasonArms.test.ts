import type { FakeGithub } from './fakeGithub'
import { Buffer } from 'node:buffer'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import labelFileContents from '../fixtures/labels/labelFileContentsResp.json'
import pullReqReviewSubmittedEvent from '../fixtures/pullReq/pullReqReviewSubmittedEvent.json'
import { blobSha, pullBody } from '../utils/ownersData'
import { start } from './fakeGithub'
import { helpersFor, repo, token } from './helpers'
import { runBundle } from './runBundle'

vi.setConfig({ testTimeout: 30_000 })

// the two arms of withdrawalReason (src/plugins/approveReview.ts) the dismissal message of the mirrored
// review is built from that approveReviewShortCircuits.test.ts never reaches: more uncovered files than
// the message names (the `and N more` tail) and an approval nobody withdrew (no `withdrawn by` suffix)
describe('dist/index.js approve.github_review dismissal reason', () => {
  let gh: FakeGithub
  const { routeOwners } = helpersFor(() => gh)

  const reviewMarker = '<!-- prow-github-actions/approve-review -->'
  const bot = { login: 'github-actions[bot]', type: 'Bot' }
  const ownersFiles: Record<string, string> = { 'sdk/OWNERS': 'approvers:\n- bob\n' }
  const ownReview = { id: 71, state: 'APPROVED', user: bot, body: `Approved via /approve by bob (OWNERS).\n${reviewMarker}`, commit_id: pullBody.head.sha, submitted_at: '2024-01-01T00:00:01Z' }
  const user = (login: string) => ({ login, type: 'User' })
  const withdrawnByBob = [
    { id: 1, body: '/approve', user: user('bob'), created_at: '2024-01-01T00:00:01Z' },
    { id: 2, body: '/approve cancel', user: user('bob'), created_at: '2024-01-01T00:00:02Z' },
  ]

  beforeAll(async () => {
    gh = await start()
  })
  beforeEach(() => gh.mergeQueueFallback({ pullRequestId: 'PR_none', headOid: pullBody.head.sha, enabled: false }))
  afterEach(() => gh.reset())
  afterAll(() => gh.close())

  // the repository opts in; GET /user is refused (an installation token), so the token's reviews are the Bot's
  function routeApprove(files: string[], comments: unknown[]) {
    const config = structuredClone(labelFileContents)
    config.content = Buffer.from('approve:\n  github_review: true\n').toString('base64')
    gh.route('GET', `${repo}/contents/.github%2Fprow.yaml`, { status: 200, body: config })
    gh.route('GET', '/user', { status: 403, body: { message: 'Resource not accessible by integration' } })
    gh.route('GET', `${repo}/git/trees/master`, { status: 200, body: { sha: 'master', truncated: false, tree: Object.keys(ownersFiles).map(path => ({ path, type: 'blob', sha: blobSha(path) })) } })
    routeOwners(ownersFiles, files, { labels: [{ name: 'approved' }] })
    gh.route('GET', `${repo}/issues/1/comments`, { status: 200, body: comments })
    gh.route('GET', `${repo}/pulls/1/reviews`, { status: 200, body: [ownReview] })
    gh.route('GET', `${repo}/labels`, { status: 200, body: [{ name: 'approved' }, { name: 'lgtm' }] })
    gh.route('DELETE', `${repo}/issues/1/labels/approved`, { status: 200, body: [] })
    gh.route('POST', `${repo}/issues/1/comments`, { status: 201, body: {} })
    gh.route('PUT', `${repo}/pulls/1/reviews/71/dismissals`, { status: 200, body: {} })
  }

  function runReview() {
    return runBundle({ eventName: 'pull_request_review', payload: pullReqReviewSubmittedEvent, inputs: token, apiUrl: gh.url })
  }

  function dismissals() {
    return gh.requestsMatching('PUT', /\/pulls\/1\/reviews\/\d+\/dismissals$/)
  }

  it('names the first five uncovered files and counts the rest', async () => {
    const files = ['sdk/a.go', 'sdk/b.go', 'sdk/c.go', 'sdk/d.go', 'sdk/e.go', 'sdk/f.go', 'sdk/g.go']
    routeApprove(files, withdrawnByBob)

    const result = await runReview()

    expect(result.status, result.stdout).toBe(0)
    expect(result.errors).toEqual([])
    // the log names every file; only the dismissal message is cut short
    expect(result.stdout).toContain(`approve: #1 is not approved; nobody approves ${files.join(', ')}`)
    expect(gh.requestsMatching('DELETE', /\/issues\/1\/labels\/approved$/)).toHaveLength(1)
    expect(dismissals().map(r => r.path)).toEqual([`${repo}/pulls/1/reviews/71/dismissals`])
    expect(dismissals()[0].body).toEqual({ message: 'approved removed: no approver covers sdk/a.go, sdk/b.go, sdk/c.go, sdk/d.go, sdk/e.go and 2 more; withdrawn by bob (/approve cancel)' })
    expect(result.stdout).toContain('approve: dismissed the approval review 71 on #1: approved removed: no approver covers sdk/a.go, sdk/b.go, sdk/c.go, sdk/d.go, sdk/e.go and 2 more; withdrawn by bob (/approve cancel)')
  })

  it('names no withdrawer when nobody took an approval back', async () => {
    // the label is set but no comment ever approved: nothing was withdrawn, the files are simply uncovered
    routeApprove(['sdk/x.go'], [])

    const result = await runReview()

    expect(result.status, result.stdout).toBe(0)
    expect(result.errors).toEqual([])
    expect(result.stdout).toContain('approve: #1 is not approved; nobody approves sdk/x.go')
    expect(gh.requestsMatching('DELETE', /\/issues\/1\/labels\/approved$/)).toHaveLength(1)
    expect(dismissals()).toHaveLength(1)
    expect(dismissals()[0].body).toEqual({ message: 'approved removed: no approver covers sdk/x.go' })
    expect((dismissals()[0].body as { message: string }).message).not.toContain('withdrawn by')
  })
})
