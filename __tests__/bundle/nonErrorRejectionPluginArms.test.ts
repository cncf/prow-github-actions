import type { FakeGithub } from './fakeGithub'
import { Buffer } from 'node:buffer'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import labelFileContents from '../fixtures/labels/labelFileContentsResp.json'
import checkSuiteCompletedEvent from '../fixtures/pullReq/checkSuiteCompletedEvent.json'
import pullReqListPulls from '../fixtures/pullReq/pullReqListPulls.json'
import { blobSha, prCommentEvent, pullBody } from '../utils/ownersData'
import { start } from './fakeGithub'
import { configReads, helpersFor, membershipReads, ownersProbe, ownersReads, queueRead, repo, token } from './helpers'
import { runBundle } from './runBundle'

vi.setConfig({ testTimeout: 30_000 })

const preload = path.resolve(__dirname, 'nonErrorRejectionPreload.cjs')
const rejected = (target: string) => `${target} rejected with a string, not an Error`

function env(target: string, extra: Record<string, string> = {}) {
  return { ...extra, NODE_OPTIONS: `--require "${preload}"`, NON_ERROR_REJECT: target }
}

function yamlConfig(text: string) {
  const file = structuredClone(labelFileContents)
  file.content = Buffer.from(text).toString('base64')
  return file
}

// The per-plugin `String(e)` / `'status' in e` folds (tide.ts:137-138, mergeQueue.ts:190, sweep.ts:132,
// trigger.ts:323, approveReview.ts:226/230) only run when the client call they wrap
// rejects with something that is not an Error. Octokit wraps every fetch rejection in a RequestError, so the
// preload hands the bundle one Response whose `status` getter throws a plain string: the one read
// @octokit/request makes outside its try/catch. Each case asserts the string reaches the plugin's own message
// unwrapped (no `[object`), that the plugin takes the arm a status-less failure takes, and that the run neither
// hangs nor reports an unhandled rejection.
describe('dist/index.js when a plugin\'s api call rejects with a non-Error value', () => {
  let gh: FakeGithub
  const { calls, expectRequests, routeOwners } = helpersFor(() => gh)

  beforeAll(async () => {
    gh = await start()
  })
  afterEach(() => gh.reset())
  afterAll(() => gh.close())

  describe('check_suite tide', () => {
    const head = checkSuiteCompletedEvent.check_suite.head_sha
    const pullRead = `GET ${repo}/pulls/1`
    const merge = `PUT ${repo}/pulls/1/merge`
    const bindingRead = `GET ${repo}/commits/${head}/status?per_page=100`
    const bound = [{ context: 'prow/lgtm', state: 'success' }]

    function cleanPr() {
      return { ...structuredClone(pullReqListPulls[0]), number: 1, labels: [{ name: 'lgtm' }], mergeable: true, mergeable_state: 'clean', head: { sha: head } }
    }

    function checkSuite(target: string) {
      return runBundle({
        eventName: 'check_suite',
        payload: { ...checkSuiteCompletedEvent, check_suite: { ...checkSuiteCompletedEvent.check_suite, pull_requests: [{ number: 1 }] } },
        inputs: token,
        apiUrl: gh.url,
        env: env(target),
      })
    }

    it('the merge rejects with a string: mergeOnce reports it with no status, the re-read runs, and the run fails naming the string', async () => {
      gh.mergeQueueFallback({ pullRequestId: 'PR_none', headOid: head, enabled: false })
      gh.commitStatuses(repo, head, bound)
      gh.route('GET', `${repo}/pulls/1`, { status: 200, body: cleanPr() })
      gh.route('PUT', `${repo}/pulls/1/merge`, { status: 200, body: { merged: true } })

      const result = await checkSuite(merge)

      expect(result.status, result.stdout).toBe(1)
      expect(result.errors).toHaveLength(2)
      expect(result.errors[0]).toBe(`could not merge pr #1: ${rejected(merge)}`)
      expect(result.errors[1]).toBe('error handling check_suite event: could not merge pull request(s) #1')
      expect(result.stdout).not.toContain('[object')
      // no status: neither the 409 "head moved" skip nor the 403 fork explanation is taken
      expect(result.stdout).not.toContain('skipping pr #1')
      expect(result.stderr).not.toMatch(/Unhandled|unhandledRejection/)
      // the faulted merge reached the fake and was recorded, then one re-read for the concurrent-merge check
      expectRequests(configReads(), [pullRead, ownersProbe, bindingRead, queueRead, merge, pullRead])
    })

    it('the merge queue state read rejects with a string: the warning names it and the merge falls back to a direct one', async () => {
      gh.mergeQueue({ pullRequestId: 'PR_kwDOtest', headOid: head, enabled: true })
      gh.commitStatuses(repo, head, bound)
      gh.route('GET', `${repo}/pulls/1`, { status: 200, body: cleanPr() })
      gh.route('PUT', `${repo}/pulls/1/merge`, { status: 200, body: { merged: true } })

      const result = await checkSuite(queueRead)

      expect(result.status, result.stdout).toBe(0)
      expect(result.errors).toEqual([])
      expect(result.stdout).toContain(`::warning::could not read the merge queue state of pr #1; falling back to a direct merge: ${rejected(queueRead)}`)
      expect(result.stdout).toContain('merged pr #1')
      expect(result.stdout).not.toContain('[object')
      expect(result.stderr).not.toMatch(/Unhandled|unhandledRejection/)
      // the faulted state read reached the fake; the queue is never asked to enqueue
      expect(gh.graphqlCalls('isMergeQueueEnabled')).toHaveLength(1)
      expect(gh.graphqlCalls('enqueuePullRequest')).toEqual([])
      expectRequests(configReads(), [pullRead, ownersProbe, bindingRead, queueRead, merge])
    })
  })

  describe('schedule sweep: a step rejects with a string', () => {
    const listPage = (page: number) => `GET ${repo}/pulls?state=open&sort=updated&direction=desc&per_page=100&page=${page}`
    const reviewsRead = `GET ${repo}/pulls/1/reviews`
    const ownersFiles: Record<string, string> = { 'OWNERS': 'approvers:\n- alice\n', 'sdk/OWNERS': 'reviewers:\n- bob\n- carol\nlabels:\n- area/sdk\n' }

    it('blunderbuss\'s review read rejects with a string: the step is recorded with the string, the later steps still run, and the sweep fails once', async () => {
      const stamp = new Date().toISOString()
      const pr = {
        ...structuredClone(pullReqListPulls[0]),
        number: 1,
        labels: [],
        created_at: stamp,
        updated_at: stamp,
        requested_reviewers: [],
        assignees: [],
        draft: false,
        mergeable: true,
        mergeable_state: 'clean',
        user: { login: 'dave' },
        head: { sha: 'sha1', repo: { full_name: 'dave/Hello-World' } },
        base: { ref: 'master', sha: 'basesha' },
      }
      gh.route('GET', repo, { status: 200, body: { default_branch: 'master' } })
      gh.route('GET', new RegExp(`^${repo}/pulls\\?`), (req) => {
        const page = new URL(req.path, gh.url).searchParams.get('page')
        return { status: 200, body: page === '1' ? [pr] : [] }
      })
      gh.route('GET', `${repo}/git/trees/master`, { status: 200, body: { sha: 'master', truncated: false, tree: Object.keys(ownersFiles).map(path => ({ path, type: 'blob', sha: blobSha(path) })) } })
      routeOwners(ownersFiles, ['sdk/x.go'], pr)
      gh.route('GET', `${repo}/issues/1`, { status: 200, body: { labels: [] } })
      gh.route('GET', `${repo}/labels`, { status: 200, body: ['area/sdk', 'approved', 'lgtm'].map(name => ({ name })) })
      gh.route('POST', `${repo}/issues/1/labels`, { status: 200, body: [] })
      gh.route('GET', `${repo}/pulls/1/reviews`, { status: 200, body: [] })
      gh.route('POST', `${repo}/pulls/1/requested_reviewers`, { status: 201, body: {} })
      gh.route('GET', `${repo}/issues/1/comments`, { status: 200, body: [] })
      gh.route('POST', `${repo}/issues/1/comments`, { status: 201, body: {} })
      gh.route('GET', '/repos/Codertocat/.project/contents/prow.yaml', { status: 404, body: { message: 'Not Found' } })

      const result = await runBundle({
        eventName: 'schedule',
        payload: {},
        inputs: { ...token, jobs: 'sweep' },
        apiUrl: gh.url,
        env: env(reviewsRead),
      })

      expect(result.status, result.stdout).toBe(1)
      expect(result.errors).toHaveLength(1)
      expect(result.errors[0]).toBe(`TypeError: error handling cron job: Error: sweep: 1 pull request(s) failed: #1 (blunderbuss: ${rejected(reviewsRead)})`)
      expect(result.stdout).toContain('sweep: #1 evaluated with 1 error(s)')
      expect(result.stdout).not.toContain('[object')
      expect(result.stderr).not.toMatch(/Unhandled|unhandledRejection/)
      // the faulted freshness read is blunderbuss's per_page=1 one; nobody is asked to review
      expect(gh.requestsMatching('GET', /\/pulls\/1\/reviews\?per_page=1$/)).toHaveLength(1)
      expect(gh.requestsMatching('POST', /\/pulls\/1\/requested_reviewers$/)).toEqual([])
      // the owners-label step before it and the approve step after it both ran
      expect(gh.requestsMatching('POST', /\/issues\/1\/labels$/).map(r => r.body)).toEqual([{ labels: ['area/sdk'] }])
      expect(calls().filter(c => c === `GET ${repo}/issues/1/comments?per_page=100`)).toHaveLength(1)
      expect(calls()).toContain(listPage(1))
    })
  })

  describe('issue_comment /retest', () => {
    const runsRead = `GET ${repo}/actions/runs?head_sha=headsha&per_page=100`
    const rerun = `POST ${repo}/actions/runs/1/rerun-failed-jobs`
    const authReads = [...ownersReads, ...membershipReads('Codertocat')]
    const prow = { id: 3, name: 'Prow', path: '.github/workflows/prow.yml', head_sha: 'headsha', status: 'in_progress', conclusion: null }
    const failedCi = { id: 1, name: 'CI', path: '.github/workflows/ci.yml', head_sha: 'headsha', status: 'completed', conclusion: 'failure' }

    beforeEach(() => gh.mergeQueueFallback({ pullRequestId: 'PR_none', headOid: pullBody.head.sha, enabled: false }))

    it('a failed-jobs re-run rejects with a string: it is neither a conflict nor forbidden, so the run fails naming the run and the string, without a comment', async () => {
      routeOwners({}, ['src/file1.txt'], { user: { login: 'some-author' }, labels: [] })
      gh.route('GET', '/orgs/Codertocat/members/Codertocat', { status: 204 })
      gh.route('GET', `${repo}/collaborators/Codertocat`, { status: 404, body: { message: 'Not Found' } })
      gh.route('POST', `${repo}/issues/1/comments`, { status: 201, body: {} })
      gh.route('GET', `${repo}/actions/runs`, { status: 200, body: { total_count: 2, workflow_runs: [failedCi, prow] } })
      gh.route('POST', /\/actions\/runs\/\d+\/rerun-failed-jobs$/, { status: 201 })

      const result = await runBundle({
        eventName: 'issue_comment',
        payload: prCommentEvent('/retest'),
        inputs: { ...token, 'prow-commands': '/retest' },
        apiUrl: gh.url,
        env: env(rerun, { GITHUB_WORKFLOW: 'Prow' }),
      })

      expect(result.status, result.stdout).toBe(1)
      expect(result.errors).toEqual([`TypeError: error handling issue comment: Error: could not re-run CI (1): ${rejected(rerun)}`])
      expect(result.stdout).not.toContain('already re-running')
      expect(result.stderr).not.toMatch(/Unhandled|unhandledRejection/)
      // the faulted re-run reached the fake; no refusal comment (the 403 arm) and no rocket
      expectRequests(authReads, [runsRead, rerun])
      expect(gh.requestsMatching('POST', /\/issues\/1\/comments$/)).toEqual([])
    })
  })

  describe('issue_comment /approve with approve.github_review', () => {
    const reviewWrite = `POST ${repo}/pulls/1/reviews`
    const ownersFiles: Record<string, string> = { 'sdk/OWNERS': 'approvers:\n- bob\n' }
    const approveComment = { id: 1, body: '/approve', user: { login: 'bob', type: 'User' }, created_at: '2024-01-01T00:00:01Z' }

    beforeEach(() => gh.mergeQueueFallback({ pullRequestId: 'PR_none', headOid: pullBody.head.sha, enabled: false }))

    it('the review submit rejects with a string: no refusal pattern and no status match, so the run fails naming the string after the label is written', async () => {
      gh.route('GET', `${repo}/contents/.github%2Fprow.yaml`, { status: 200, body: yamlConfig('approve:\n  github_review: true\n') })
      gh.route('GET', '/user', { status: 403, body: { message: 'Resource not accessible by integration' } })
      routeOwners(ownersFiles, ['sdk/x.go'], { labels: [] })
      gh.route('GET', `${repo}/issues/1/comments`, { status: 200, body: [approveComment] })
      gh.route('GET', `${repo}/pulls/1/reviews`, { status: 200, body: [] })
      gh.route('GET', `${repo}/labels`, { status: 200, body: [{ name: 'approved' }, { name: 'lgtm' }] })
      gh.route('POST', `${repo}/issues/1/labels`, { status: 200, body: [] })
      gh.route('POST', `${repo}/issues/1/comments`, { status: 201, body: {} })
      gh.route('POST', `${repo}/pulls/1/reviews`, { status: 200, body: { id: 9 } })

      const result = await runBundle({
        eventName: 'issue_comment',
        payload: prCommentEvent('/approve', 'bob'),
        inputs: { ...token, 'prow-commands': '/approve' },
        apiUrl: gh.url,
        env: env(reviewWrite),
      })

      expect(result.status, result.stdout).toBe(1)
      expect(result.errors.some(e => e.includes(`could not submit the approval review: ${rejected(reviewWrite)}`))).toBe(true)
      expect(result.stdout).not.toContain('::warning::')
      expect(result.stdout).not.toContain('[object')
      expect(result.stderr).not.toMatch(/Unhandled|unhandledRejection/)
      // the label landed before the faulted submit, which reached the fake once
      expect(gh.requestsMatching('POST', /\/issues\/1\/labels$/).map(r => r.body)).toEqual([{ labels: ['approved'] }])
      expect(gh.requestsMatching('POST', /\/pulls\/1\/reviews$/)).toHaveLength(1)
    })
  })
})
