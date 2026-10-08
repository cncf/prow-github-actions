import type { FakeGithub } from './fakeGithub'
import { Buffer } from 'node:buffer'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import labelFileContents from '../fixtures/labels/labelFileContentsResp.json'
import { prCommentEvent, pullBody } from '../utils/ownersFixtures'
import { start } from './fakeGithub'
import { helpersFor, repo, token } from './helpers'
import { runBundle } from './runBundle'

vi.setConfig({ testTimeout: 30_000 })

// the mirrored review (`approve.github_review`) as src/plugins/approveReview.ts syncs it, driven through
// dist/index.js: the happy path and the `/approve cancel` dismissal live in bundle.test.ts; this file covers
// the refusals GitHub can answer the review with, the short-circuits, and the failures that end the run
describe('dist/index.js approve.github_review', () => {
  let gh: FakeGithub
  const { routeOwners } = helpersFor(() => gh)

  const reviewMarker = '<!-- prow-github-actions/approve-review -->'
  const bot = { login: 'github-actions[bot]', type: 'Bot' }
  const ownersFiles: Record<string, string> = { 'sdk/OWNERS': 'approvers:\n- bob\n' }
  const approveComment = { id: 1, body: '/approve', user: { login: 'bob', type: 'User' }, created_at: '2024-01-01T00:00:01Z' }
  const ownReview = { id: 71, state: 'APPROVED', user: bot, body: `Approved via /approve by bob (OWNERS).\n${reviewMarker}`, commit_id: pullBody.head.sha, submitted_at: '2024-01-01T00:00:01Z' }

  beforeAll(async () => {
    gh = await start()
  })
  beforeEach(() => gh.mergeQueueFallback({ pullRequestId: 'PR_none', headOid: pullBody.head.sha, enabled: false }))
  afterEach(() => gh.reset())
  afterAll(() => gh.close())

  // the repository opts in; `user` is what GET /user answers for the token (403: an installation token)
  function routeApprove(options: { labels?: string[], comments?: unknown[], reviews?: unknown[], pull?: Record<string, unknown>, user?: { status: number, body: unknown } } = {}) {
    const config = structuredClone(labelFileContents)
    config.content = Buffer.from('approve:\n  github_review: true\n').toString('base64')
    gh.route('GET', `${repo}/contents/.github%2Fprow.yaml`, { status: 200, body: config })
    gh.route('GET', '/user', options.user ?? { status: 403, body: { message: 'Resource not accessible by integration' } })
    routeOwners(ownersFiles, ['sdk/x.go'], { labels: (options.labels ?? []).map(name => ({ name })), ...options.pull })
    gh.route('GET', `${repo}/issues/1/comments`, { status: 200, body: options.comments ?? [approveComment] })
    gh.route('GET', `${repo}/pulls/1/reviews`, { status: 200, body: options.reviews ?? [] })
    gh.route('GET', `${repo}/labels`, { status: 200, body: [{ name: 'approved' }, { name: 'lgtm' }] })
    gh.route('POST', `${repo}/issues/1/labels`, { status: 200, body: [] })
    gh.route('DELETE', `${repo}/issues/1/labels/approved`, { status: 200, body: [] })
    gh.route('POST', `${repo}/issues/1/comments`, { status: 201, body: {} })
  }

  function runApprove(body = '/approve') {
    return runBundle({
      eventName: 'issue_comment',
      payload: prCommentEvent(body, 'bob'),
      inputs: { ...token, 'prow-commands': '/approve' },
      apiUrl: gh.url,
    })
  }

  function submittedReviews() {
    return gh.requestsMatching('POST', /\/pulls\/1\/reviews$/)
  }

  function labelAdds() {
    return gh.requestsMatching('POST', /\/issues\/1\/labels$/).map(r => r.body)
  }

  it('warns, and still succeeds, when GitHub Actions is not permitted to approve pull requests (422)', async () => {
    routeApprove()
    gh.route('POST', `${repo}/pulls/1/reviews`, { status: 422, body: { message: 'GitHub Actions is not permitted to approve pull requests.' } })

    const result = await runApprove()

    expect(result.status, result.stdout).toBe(0)
    expect(result.errors).toEqual([])
    expect(labelAdds()).toEqual([{ labels: ['approved'] }])
    expect(submittedReviews()).toHaveLength(1)
    expect(result.stdout).toMatch(/::warning::cannot submit the approval review: enable "Allow GitHub Actions to create and approve pull requests" \(Settings → Actions → General\) or pass a token that can \(approve\.github_review\): .*not permitted to approve pull requests/)
  })

  it('warns about the missing pull-requests: write permission on any other 403', async () => {
    routeApprove()
    gh.route('POST', `${repo}/pulls/1/reviews`, { status: 403, body: { message: 'Resource not accessible by integration' } })

    const result = await runApprove()

    expect(result.status, result.stdout).toBe(0)
    expect(result.errors).toEqual([])
    expect(labelAdds()).toEqual([{ labels: ['approved'] }])
    expect(result.stdout).toMatch(/::warning::cannot submit the approval review: the token was refused; grant the workflow `pull-requests: write` \(approve\.github_review\): .*Resource not accessible by integration/)
  })

  it('warns, naming the author, when GitHub refuses the review as a self-approval', async () => {
    routeApprove()
    gh.route('POST', `${repo}/pulls/1/reviews`, { status: 422, body: { message: 'Review Can not approve your own pull request' } })

    const result = await runApprove()

    expect(result.status, result.stdout).toBe(0)
    expect(result.errors).toEqual([])
    expect(submittedReviews()).toHaveLength(1)
    expect(result.stdout).toContain('::warning::cannot submit the approval review: #1 was opened by the token\'s own identity (codertocat), and GitHub does not let an author approve their own pull request (approve.github_review)')
  })

  it('does not even try when the token is a user who opened the pull request', async () => {
    routeApprove({ user: { status: 200, body: { login: 'Codertocat' } } })

    const result = await runApprove()

    expect(result.status, result.stdout).toBe(0)
    expect(result.errors).toEqual([])
    expect(labelAdds()).toEqual([{ labels: ['approved'] }])
    expect(submittedReviews()).toEqual([])
    expect(result.stdout).toContain('::warning::cannot submit the approval review: #1 was opened by the token\'s own identity (codertocat)')
  })

  it('fails the run, after the label is written, when GitHub answers the review with any other error', async () => {
    routeApprove()
    gh.route('POST', `${repo}/pulls/1/reviews`, { status: 500, body: { message: 'boom' } })

    const result = await runApprove()

    expect(result.status, result.stdout).toBe(1)
    expect(result.errors.some(e => e.includes('could not submit the approval review'))).toBe(true)
    expect(result.stdout).not.toMatch(/::warning::cannot submit the approval review/)
    expect(labelAdds()).toEqual([{ labels: ['approved'] }])
  })

  it('submits nothing on a draft and says so', async () => {
    routeApprove({ pull: { draft: true } })

    const result = await runApprove()

    expect(result.status, result.stdout).toBe(0)
    expect(result.errors).toEqual([])
    expect(labelAdds()).toEqual([{ labels: ['approved'] }])
    expect(submittedReviews()).toEqual([])
    expect(result.stdout).toContain('::debug::approve: #1 is a draft; no approval review is submitted until it is ready for review')
  })

  it('submits nothing when its own review already sits on the head commit', async () => {
    routeApprove({ labels: ['approved'], reviews: [ownReview] })

    const result = await runApprove()

    expect(result.status, result.stdout).toBe(0)
    expect(result.errors).toEqual([])
    expect(submittedReviews()).toEqual([])
    expect(gh.requestsMatching('PUT', /dismissals$/)).toEqual([])
    expect(result.stdout).toContain(`::debug::approve: #1 already carries the approval review on ${pullBody.head.sha}`)
  })

  it('fails the run when GitHub refuses to dismiss the mirrored review on /approve cancel', async () => {
    routeApprove({
      labels: ['approved'],
      comments: [approveComment, { id: 2, body: '/approve cancel', user: { login: 'bob', type: 'User' }, created_at: '2024-01-01T00:00:02Z' }],
      reviews: [ownReview],
    })
    gh.route('PUT', `${repo}/pulls/1/reviews/71/dismissals`, { status: 403, body: { message: 'Only users with push access can dismiss reviews' } })

    const result = await runApprove('/approve cancel')

    expect(result.status, result.stdout).toBe(1)
    expect(result.errors.some(e => e.includes('could not dismiss the approval review 71'))).toBe(true)
    expect(gh.requestsMatching('DELETE', /\/issues\/1\/labels\/approved$/)).toHaveLength(1)
    expect(submittedReviews()).toEqual([])
  })

  it('fails the run when the token cannot be identified', async () => {
    routeApprove({ user: { status: 500, body: { message: 'boom' } } })

    const result = await runApprove()

    expect(result.status, result.stdout).toBe(1)
    expect(result.errors.some(e => e.includes('could not identify the token for approve.github_review'))).toBe(true)
    expect(submittedReviews()).toEqual([])
    expect(labelAdds()).toEqual([])
  })
})
