import type { FakeGithub } from './fakeGithub'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import pullReqOpenedEvent from '../fixtures/pullReq/pullReqOpenedEvent.json'
import pullReqReviewSubmittedEvent from '../fixtures/pullReq/pullReqReviewSubmittedEvent.json'
import { blobSha } from '../utils/ownersData'
import { start } from './fakeGithub'
import { helpersFor, repo, token } from './helpers'
import { runBundle } from './runBundle'

vi.setConfig({ testTimeout: 30_000 })

// GitHub's `issue-comment` schema types `body` as optional. Every other approve scenario serves a body on each
// listed comment, so approvalEvents' `comment.body ?? ''` fold (src/plugins/approve.ts:101) never took the absent
// arm through dist/index.js. A bodyless comment carries no command: it is skipped, and the evaluation reads the
// remaining comments as if it were not there.
describe('dist/index.js approve plugin with a bodyless comment in the listing', () => {
  let gh: FakeGithub
  const { routeOwners } = helpersFor(() => gh)

  const owners = { 'OWNERS': 'approvers:\n- alice\n', 'sdk/OWNERS': 'approvers:\n- bob\n' }
  const bodyless = { id: 1, user: { login: 'bob', type: 'User' }, created_at: '2024-01-01T00:00:01Z' }
  const aliceApproves = { id: 2, body: '/approve', user: { login: 'alice', type: 'User' }, created_at: '2024-01-01T00:00:02Z' }

  beforeAll(async () => {
    gh = await start()
  })
  beforeEach(() => gh.mergeQueueFallback({ pullRequestId: 'PR_none', headOid: pullReqOpenedEvent.pull_request.head.sha, enabled: false }))
  afterEach(() => gh.reset())
  afterAll(() => gh.close())

  function routeEvaluation(comments: unknown[]) {
    gh.route('GET', `${repo}/git/trees/master`, { status: 200, body: { sha: 'master', truncated: false, tree: Object.keys(owners).map(path => ({ path, type: 'blob', sha: blobSha(path) })) } })
    routeOwners(owners, ['sdk/x.go'], { user: { login: 'Codertocat' }, labels: [] })
    gh.route('GET', `${repo}/issues/1/comments`, { status: 200, body: comments })
    gh.route('GET', `${repo}/pulls/1/reviews`, { status: 200, body: [] })
    gh.route('GET', `${repo}/labels`, { status: 200, body: [{ name: 'approved' }, { name: 'lgtm' }] })
    gh.route('POST', `${repo}/issues/1/labels`, { status: 200, body: [] })
    gh.route('POST', `${repo}/issues/1/comments`, { status: 201, body: {} })
  }

  function runReview() {
    return runBundle({ eventName: 'pull_request_review', payload: pullReqReviewSubmittedEvent, inputs: token, apiUrl: gh.url })
  }

  function postedNotifier() {
    const comments = gh.requestsMatching('POST', /\/issues\/1\/comments$/)
    expect(comments).toHaveLength(1)
    return (comments[0].body as { body: string }).body
  }

  it('an approver\'s comment with no body is not an approval: not approved, and an approver is suggested', async () => {
    routeEvaluation([bodyless])

    const result = await runReview()

    expect(result.status, result.stdout).toBe(0)
    expect(result.errors).toEqual([])
    expect(result.stdout).toContain('approve: #1 is not approved; nobody approves sdk/x.go')
    expect(gh.requestsMatching('POST', /\/issues\/1\/labels$/)).toEqual([])
    expect(postedNotifier()).toContain('please assign **alice**')
  })

  it('the bodyless comment is skipped and the /approve that follows it approves', async () => {
    routeEvaluation([bodyless, aliceApproves])

    const result = await runReview()

    expect(result.status, result.stdout).toBe(0)
    expect(result.errors).toEqual([])
    expect(gh.requestsMatching('POST', /\/issues\/1\/labels$/).map(r => r.body)).toEqual([{ labels: ['approved'] }])
    const notifier = postedNotifier()
    expect(notifier).toContain('This pull-request has been approved by: *alice*')
    expect(notifier).not.toContain('bob')
  })
})
