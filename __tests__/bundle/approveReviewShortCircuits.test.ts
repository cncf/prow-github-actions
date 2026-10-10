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

// the mirrored review (`approve.github_review`) when the pull request is NOT approved, driven through dist/index.js:
// syncApprovalReview's not-open and nothing-to-dismiss short-circuits, and the two withdrawalReason arms the
// dismissal message is built from (a pull request changing no files; `/lgtm cancel` counting only under
// approve.lgtm_acts_as_approve). The refusals and failures GitHub can answer the review with live elsewhere.
describe('dist/index.js approve.github_review on a pull request that is not approved', () => {
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

  interface RouteOptions {
    files?: string[]
    labels?: string[]
    comments?: unknown[]
    reviews?: unknown[]
    pull?: Record<string, unknown>
    config?: string
  }

  // the repository opts in; GET /user is refused (an installation token), so the token's reviews are the Bot's
  function routeApprove(options: RouteOptions = {}) {
    const config = structuredClone(labelFileContents)
    config.content = Buffer.from(options.config ?? 'approve:\n  github_review: true\n').toString('base64')
    gh.route('GET', `${repo}/contents/.github%2Fprow.yaml`, { status: 200, body: config })
    gh.route('GET', '/user', { status: 403, body: { message: 'Resource not accessible by integration' } })
    gh.route('GET', `${repo}/git/trees/master`, { status: 200, body: { sha: 'master', truncated: false, tree: Object.keys(ownersFiles).map(path => ({ path, type: 'blob', sha: blobSha(path) })) } })
    routeOwners(ownersFiles, options.files ?? ['sdk/x.go'], { labels: (options.labels ?? []).map(name => ({ name })), ...options.pull })
    gh.route('GET', `${repo}/issues/1/comments`, { status: 200, body: options.comments ?? [] })
    gh.route('GET', `${repo}/pulls/1/reviews`, { status: 200, body: options.reviews ?? [ownReview] })
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

  it('leaves the approval review of a pull request that is no longer open alone', async () => {
    routeApprove({ labels: ['approved'], pull: { state: 'closed' } })

    const result = await runReview()

    expect(result.status, result.stdout).toBe(0)
    expect(result.errors).toEqual([])
    expect(result.stdout).toContain('approve: #1 is not approved; nobody approves sdk/x.go')
    expect(gh.requestsMatching('DELETE', /\/issues\/1\/labels\/approved$/)).toHaveLength(1)
    expect(result.stdout).toContain('::debug::approve: #1 is not open; its approval review is left alone')
    expect(dismissals()).toEqual([])
    expect(gh.requestsMatching('POST', /\/pulls\/1\/reviews$/)).toEqual([])
  })

  it('has nothing to dismiss when the token never submitted an approval review', async () => {
    routeApprove({
      labels: ['approved'],
      reviews: [
        { id: 70, state: 'APPROVED', user: bot, body: 'no marker', commit_id: pullBody.head.sha, submitted_at: '2024-01-01T00:00:00Z' },
        { id: 72, state: 'DISMISSED', user: bot, body: `stale\n${reviewMarker}`, commit_id: 'older', submitted_at: '2024-01-01T00:00:00Z' },
        { id: 73, state: 'APPROVED', user: user('rita'), body: `copied\n${reviewMarker}`, commit_id: pullBody.head.sha, submitted_at: '2024-01-01T00:00:00Z' },
      ],
    })

    const result = await runReview()

    expect(result.status, result.stdout).toBe(0)
    expect(result.errors).toEqual([])
    expect(gh.requestsMatching('DELETE', /\/issues\/1\/labels\/approved$/)).toHaveLength(1)
    expect(result.stdout).toContain('::debug::approve: #1 carries no approval review to dismiss')
    expect(dismissals()).toEqual([])
  })

  it('dismisses the approval review of a pull request that changes no files, saying so', async () => {
    routeApprove({ files: [], labels: ['approved'] })

    const result = await runReview()

    expect(result.status, result.stdout).toBe(0)
    expect(result.errors).toEqual([])
    expect(result.stdout).toContain('approve: #1 is not approved; nobody approves anything')
    expect(dismissals().map(r => r.path)).toEqual([`${repo}/pulls/1/reviews/71/dismissals`])
    expect(dismissals()[0].body).toEqual({ message: 'approved removed: the pull request changes no files' })
    expect(result.stdout).toContain('approve: dismissed the approval review 71 on #1: approved removed: the pull request changes no files')
  })

  describe('the withdrawn-by list of the dismissal message', () => {
    const lgtmCancelByCarol = { id: 3, body: '/lgtm cancel', user: user('carol'), created_at: '2024-01-01T00:00:03Z' }

    it('ignores /lgtm cancel by default, when /lgtm does not act as approve', async () => {
      routeApprove({ labels: ['approved'], comments: [...withdrawnByBob, lgtmCancelByCarol] })

      const result = await runReview()

      expect(result.status, result.stdout).toBe(0)
      expect(result.errors).toEqual([])
      expect(dismissals()).toHaveLength(1)
      expect(dismissals()[0].body).toEqual({ message: 'approved removed: no approver covers sdk/x.go; withdrawn by bob (/approve cancel)' })
    })

    it('names /lgtm cancel under approve.lgtm_acts_as_approve', async () => {
      routeApprove({
        labels: ['approved'],
        comments: [...withdrawnByBob, lgtmCancelByCarol],
        config: 'approve:\n  github_review: true\n  lgtm_acts_as_approve: true\n',
      })

      const result = await runReview()

      expect(result.status, result.stdout).toBe(0)
      expect(result.errors).toEqual([])
      expect(dismissals()).toHaveLength(1)
      expect(dismissals()[0].body).toEqual({ message: 'approved removed: no approver covers sdk/x.go; withdrawn by bob (/approve cancel), carol (/lgtm cancel)' })
    })
  })
})
