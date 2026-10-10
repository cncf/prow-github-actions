import type { FakeGithub } from './fakeGithub'
import { Buffer } from 'node:buffer'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import labelFileContents from '../fixtures/labels/labelFileContentsResp.json'
import pullReqOpenedEvent from '../fixtures/pullReq/pullReqOpenedEvent.json'
import pullReqReviewSubmittedEvent from '../fixtures/pullReq/pullReqReviewSubmittedEvent.json'
import { blobSha, prCommentEvent } from '../utils/ownersData'
import { start } from './fakeGithub'
import { helpersFor, repo, token } from './helpers'
import { runBundle } from './runBundle'

vi.setConfig({ testTimeout: 30_000 })

// the arms of src/plugins/approve.ts that bundle.test.ts' happy paths never reach — the handlers' early
// returns, evaluateApproval's read and write failures, the notifier's no-files / uncoverable-file /
// up-to-date renderings and the lgtm_acts_as_approve and require_self_approval settings — driven through
// dist/index.js against the fake api
describe('dist/index.js approve plugin arms', () => {
  let gh: FakeGithub
  const { calls, routeOwners } = helpersFor(() => gh)

  const marker = '<!-- prow-github-actions/approve -->'
  const reviewMarker = '<!-- prow-github-actions/approve-review -->'
  const bot = { login: 'github-actions[bot]', type: 'Bot' }
  const commentsRead = `GET ${repo}/issues/1/comments?per_page=100`
  const reviewsRead = `GET ${repo}/pulls/1/reviews?per_page=100`

  const ownersFiles: Record<string, string> = {
    'OWNERS': 'approvers:\n- alice\n',
    'sdk/OWNERS': 'approvers:\n- bob\n- dave\n',
  }

  beforeAll(async () => {
    gh = await start()
  })
  beforeEach(() => gh.mergeQueueFallback({ pullRequestId: 'PR_none', headOid: pullReqOpenedEvent.pull_request.head.sha, enabled: false }))
  afterEach(() => gh.reset())
  afterAll(() => gh.close())

  function prowConfig(text: string) {
    const file = structuredClone(labelFileContents)
    file.content = Buffer.from(text).toString('base64')
    gh.route('GET', `${repo}/contents/.github%2Fprow.yaml`, { status: 200, body: file })
  }

  interface EvaluationOptions {
    owners?: Record<string, string>
    author?: string
    labels?: string[]
    comments?: unknown[]
    reviews?: unknown[]
  }

  // a pull request on a base branch with OWNERS files, as approve reads and writes it; the tide gate that follows
  // approve on the same event sees no lgtm and skips, so no merge is routed
  function routeEvaluation(files: string[], options: EvaluationOptions = {}) {
    const owners = options.owners ?? ownersFiles
    gh.route('GET', `${repo}/git/trees/master`, { status: 200, body: { sha: 'master', truncated: false, tree: Object.keys(owners).map(path => ({ path, type: 'blob', sha: blobSha(path) })) } })
    routeOwners(owners, files, { user: { login: options.author ?? 'Codertocat' }, labels: (options.labels ?? []).map(name => ({ name })) })
    gh.route('GET', `${repo}/issues/1/comments`, { status: 200, body: options.comments ?? [] })
    gh.route('GET', `${repo}/pulls/1/reviews`, { status: 200, body: options.reviews ?? [] })
    gh.route('GET', `${repo}/labels`, { status: 200, body: [{ name: 'approved' }, { name: 'lgtm' }] })
    gh.route('POST', `${repo}/issues/1/labels`, { status: 200, body: [] })
    gh.route('DELETE', `${repo}/issues/1/labels/approved`, { status: 200, body: [] })
    gh.route('POST', `${repo}/issues/1/comments`, { status: 201, body: {} })
    gh.route('PATCH', `${repo}/issues/comments/900`, { status: 200, body: {} })
  }

  function runReview(payload: unknown = pullReqReviewSubmittedEvent) {
    return runBundle({ eventName: 'pull_request_review', payload, inputs: token, apiUrl: gh.url })
  }

  function postedNotifier() {
    const comments = gh.requestsMatching('POST', /\/issues\/1\/comments$/)
    expect(comments).toHaveLength(1)
    return (comments[0].body as { body: string }).body
  }

  describe('handler early returns', () => {
    it('pull_request closed: approve skips the action before any read of the pull request\'s comments', async () => {
      routeOwners({}, ['sdk/x.go'])

      const result = await runBundle({ eventName: 'pull_request', payload: { ...pullReqOpenedEvent, action: 'closed' }, inputs: token, apiUrl: gh.url })

      expect(result.status, result.stdout).toBe(0)
      expect(result.errors).toEqual([])
      expect(result.stdout).toContain('approve: skipping closed action')
      expect(calls()).not.toContain(commentsRead)
      expect(gh.requestsMatching('POST', /\/issues\/1\/(labels|comments)$/)).toEqual([])
    })

    it('pull_request_review submitted by the mirrored approval review itself evaluates nothing', async () => {
      routeEvaluation(['sdk/x.go'])
      const review = { ...pullReqReviewSubmittedEvent.review, id: 71, body: `Approved via /approve by bob (OWNERS).\n${reviewMarker}` }

      const result = await runReview({ ...pullReqReviewSubmittedEvent, review })

      expect(result.status, result.stdout).toBe(0)
      expect(result.errors).toEqual([])
      expect(result.stdout).toContain('approve: review 71 is the approval review this action mirrors; nothing to evaluate')
      expect(calls()).not.toContain(commentsRead)
      expect(calls()).not.toContain(reviewsRead)
      expect(gh.requestsMatching('POST', /\/issues\/1\/(labels|comments)$/)).toEqual([])
    })

    it('pull_request_review without a pull request in the payload fails the run naming the payload', async () => {
      const { pull_request: _dropped, ...payload } = pullReqReviewSubmittedEvent

      const result = await runReview(payload)

      expect(result.status, result.stdout).toBe(1)
      expect(result.errors.some(e => e.includes('github context payload missing pull request'))).toBe(true)
      expect(gh.requestsMatching('POST', /./)).toEqual([])
    })

    it('the OWNERS files vanishing between the branch probe and the evaluation leaves the pull request alone', async () => {
      // the probe sees OWNERS on the branch, the branch tip read for the evaluation finds an empty tree
      gh.route('GET', `${repo}/git/trees/master`, { status: 200, body: { sha: 'master', truncated: false, tree: [{ path: 'OWNERS', type: 'blob', sha: blobSha('OWNERS') }] } })
      routeOwners({}, ['sdk/x.go'])

      const result = await runReview()

      expect(result.status, result.stdout).toBe(0)
      expect(result.errors).toEqual([])
      expect(result.stdout).toContain('approve: the base of #1 has no OWNERS files, nothing to evaluate')
      expect(calls()).not.toContain(commentsRead)
      expect(gh.requestsMatching('POST', /\/issues\/1\/(labels|comments)$/)).toEqual([])
      expect(gh.requestsMatching('DELETE', /./)).toEqual([])
    })
  })

  describe('the notifier', () => {
    it('files no OWNERS file covers are listed after the OWNERS entries, sorted, with nobody to suggest', async () => {
      // no root OWNERS: docs/ is covered by nothing, so no set of approvers can ever complete the approval
      routeEvaluation(['docs/b.md', 'sdk/x.go', 'docs/a.md'], {
        owners: { 'sdk/OWNERS': ownersFiles['sdk/OWNERS'] },
        comments: [{ id: 1, body: '/approve', user: { login: 'bob', type: 'User' }, created_at: '2024-01-01T00:00:01Z' }],
      })

      const result = await runReview()

      expect(result.status, result.stdout).toBe(0)
      expect(result.errors).toEqual([])
      expect(result.stdout).toContain('approve: #1 is not approved; nobody approves docs/b.md, docs/a.md')
      expect(gh.requestsMatching('POST', /\/issues\/1\/labels$/)).toEqual([])
      const body = postedNotifier()
      expect(body).toContain('This pull-request has been approved by: *bob*')
      expect(body).not.toContain('please assign')
      const sdk = `- ~~[sdk/OWNERS](https://github.com/Codertocat/Hello-World/blob/basesha/sdk/OWNERS)~~ [bob]`
      expect(body).toContain(`${sdk}\n- **docs/a.md** (no OWNERS file covers this file)\n- **docs/b.md** (no OWNERS file covers this file)\n`)
    })

    it('a notifier already saying what the evaluation would say is neither re-posted nor edited', async () => {
      const comments = [{ id: 1, body: '/approve', user: { login: 'bob', type: 'User' }, created_at: '2024-01-01T00:00:01Z' }]
      routeEvaluation(['sdk/x.go'], { comments })
      const first = await runReview()
      expect(first.status, first.stdout).toBe(0)
      const body = postedNotifier()
      expect(body).toContain('This PR is **APPROVED**')
      gh.reset()

      // the same evaluation again, approved already on and the bot's notifier already carrying that body
      routeEvaluation(['sdk/x.go'], { labels: ['approved'], comments: [{ id: 900, body, user: bot, created_at: '2024-01-01T00:00:00Z' }, ...comments] })

      const result = await runReview()

      expect(result.status, result.stdout).toBe(0)
      expect(result.errors).toEqual([])
      expect(result.stdout).toContain('approve: the notifier on #1 is up to date')
      expect(result.stdout).toContain('approve: the approved label on #1 is already correct')
      expect(gh.requestsMatching('POST', /\/issues\/1\/(labels|comments)$/)).toEqual([])
      expect(gh.requestsMatching('PATCH', /./)).toEqual([])
    })
  })

  describe('read and write failures fail the run after the label is synced', () => {
    // the first matching route wins in the fake, so each failure goes in before routeEvaluation's success
    it('a refused notifier edit', async () => {
      gh.route('PATCH', `${repo}/issues/comments/900`, { status: 500, body: { message: 'boom' } })
      routeEvaluation(['sdk/x.go'], {
        comments: [
          { id: 900, body: `stale\n${marker}`, user: bot, created_at: '2024-01-01T00:00:00Z' },
          { id: 1, body: '/approve', user: { login: 'bob', type: 'User' }, created_at: '2024-01-01T00:00:01Z' },
        ],
      })

      const result = await runReview()

      expect(result.status, result.stdout).toBe(1)
      expect(result.errors.some(e => e.includes('could not update the approval notifier: HttpError: boom'))).toBe(true)
      expect(gh.requestsMatching('POST', /\/issues\/1\/labels$/).map(r => r.body)).toEqual([{ labels: ['approved'] }])
      expect(gh.requestsMatching('POST', /\/issues\/1\/comments$/)).toEqual([])
    })

    it.each([
      ['comments', `${repo}/issues/1/comments`, 'could not list comments: HttpError: boom'],
      ['reviews', `${repo}/pulls/1/reviews`, 'could not list reviews: HttpError: boom'],
    ])('a failed %s read, before any write', async (_name, path, wantErr) => {
      gh.route('GET', path, { status: 500, body: { message: 'boom' } })
      routeEvaluation(['sdk/x.go'])

      const result = await runReview()

      expect(result.status, result.stdout).toBe(1)
      expect(result.errors.some(e => e.includes(wantErr))).toBe(true)
      expect(gh.requestsMatching('POST', /\/issues\/1\/(labels|comments)$/)).toEqual([])
      expect(gh.requestsMatching('PATCH', /./)).toEqual([])
    })
  })

  describe('approve settings', () => {
    const lgtm = { id: 1, body: '/lgtm', user: { login: 'bob', type: 'User' }, created_at: '2024-01-01T00:00:01Z' }
    const removeLgtm = { id: 2, body: '/remove-lgtm', user: { login: 'bob', type: 'User' }, created_at: '2024-01-01T00:00:02Z' }

    it('by default /lgtm from an approver is ignored: not approved, and an approver is suggested', async () => {
      routeEvaluation(['sdk/x.go'], { comments: [lgtm] })

      const result = await runReview()

      expect(result.status, result.stdout).toBe(0)
      expect(result.errors).toEqual([])
      expect(result.stdout).toContain('approve: #1 is not approved; nobody approves sdk/x.go')
      expect(gh.requestsMatching('POST', /\/issues\/1\/labels$/)).toEqual([])
      // alice (root OWNERS) and bob each cover the one file; the tie goes alphabetically
      expect(postedNotifier()).toContain('please assign **alice**')
    })

    it('with lgtm_acts_as_approve, /remove-lgtm after it withdraws', async () => {
      prowConfig('approve:\n  lgtm_acts_as_approve: true\n')
      routeEvaluation(['sdk/x.go'], { comments: [lgtm, removeLgtm] })

      const result = await runReview()

      expect(result.status, result.stdout).toBe(0)
      expect(result.errors).toEqual([])
      expect(result.stdout).toContain('approve: #1 is not approved; nobody approves sdk/x.go')
      expect(gh.requestsMatching('POST', /\/issues\/1\/labels$/).map(r => r.body)).toEqual([])
      expect(postedNotifier()).toContain('This PR is **NOT APPROVED**')
    })

    it('with require_self_approval the author\'s /approve is ignored and another approver of the file is suggested', async () => {
      prowConfig('approve:\n  require_self_approval: true\n')
      // alice would otherwise win the suggestion tie (see above); as the author she is excluded from it too
      routeEvaluation(['sdk/x.go'], {
        author: 'alice',
        comments: [{ id: 1, body: '/approve', user: { login: 'alice', type: 'User' }, created_at: '2024-01-01T00:00:01Z' }],
      })

      const result = await runReview()

      expect(result.status, result.stdout).toBe(0)
      expect(result.errors).toEqual([])
      expect(result.stdout).toContain('approve: #1 is not approved; nobody approves sdk/x.go')
      expect(gh.requestsMatching('POST', /\/issues\/1\/labels$/)).toEqual([])
      const body = postedNotifier()
      expect(body).toContain('This pull-request has been approved by:\n')
      expect(body).toContain('please assign **bob**')
    })

    it('with require_self_approval an issue_comment /approve by the author is refused with a comment before any evaluation', async () => {
      prowConfig('approve:\n  require_self_approval: true\n')
      routeEvaluation(['sdk/x.go'], { author: 'some-author' })

      const result = await runBundle({
        eventName: 'issue_comment',
        payload: prCommentEvent('/approve', 'some-author'),
        inputs: { ...token, 'prow-commands': '/approve' },
        apiUrl: gh.url,
      })

      const wantErr = 'Cannot approve the pull request: you cannot approve your own PR (approve.require_self_approval is set).'
      expect(result.status, result.stdout).toBe(1)
      expect(result.errors.some(e => e.includes('you cannot approve your own PR'))).toBe(true)
      expect(postedNotifier()).toBe(wantErr)
      expect(gh.requestsMatching('POST', /\/issues\/1\/labels$/)).toEqual([])
      expect(calls()).not.toContain(commentsRead)
    })
  })
})
