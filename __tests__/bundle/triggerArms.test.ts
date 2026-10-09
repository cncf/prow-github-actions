import type { FakeGithub } from './fakeGithub'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import pullReqOpenedEvent from '../fixtures/pullReq/pullReqOpenedEvent.json'
import { prCommentEvent } from '../utils/ownersFixtures'
import { start } from './fakeGithub'
import { comment, helpersFor, membershipReads, ownersProbe, ownersReads, queueRead, repo, token } from './helpers'
import { runBundle } from './runBundle'

vi.setConfig({ testTimeout: 30_000 })

// the arms of src/issueComment/trigger.ts that bundle.test.ts' happy paths and
// triggerTestAndLgtmCancel.test.ts' /test cases leave out: /retest with nothing failed, with every
// re-run already running or refused outright, /ok-to-test by the author, on an already trusted pull
// request and against a refused approval, plus the shared run-list, reaction and refusal failures
describe('dist/index.js /retest and /ok-to-test arms', () => {
  const commentPost = `POST ${repo}/issues/1/comments`
  const rocket = `POST ${repo}/issues/comments/492700400/reactions`
  const runsRead = `GET ${repo}/actions/runs?head_sha=headsha&per_page=100`
  const authReads = [...ownersReads, ...membershipReads('Codertocat')]
  const tail = [`GET ${repo}/pulls/1`, ownersProbe, queueRead]
  let gh: FakeGithub
  const { calls, expectCommandThenConfig, expectRequests, routeOwners } = helpersFor(() => gh)

  beforeAll(async () => {
    gh = await start()
  })
  beforeEach(() => gh.mergeQueueFallback({ pullRequestId: 'PR_none', headOid: pullReqOpenedEvent.pull_request.head.sha, enabled: false }))
  afterEach(() => gh.reset())
  afterAll(() => gh.close())

  function comments() {
    return gh.requestsMatching('POST', /\/issues\/1\/comments$/).map(r => (r.body as { body: string }).body)
  }

  const boom = { status: 500, body: { message: 'boom' } }

  // the pull request by some-author with an OWNERS-less base tree, so Codertocat is authorized by org membership;
  // the fake answers the first matching route, so a failing comment or reaction is routed here, not afterwards
  function routeAuthorizedPullRequest({ labels = [], commentWrite = { status: 201, body: {} }, reactionWrite = { status: 201, body: { content: 'rocket' } } }: {
    labels?: string[]
    commentWrite?: { status: number, body: unknown }
    reactionWrite?: { status: number, body: unknown }
  } = {}) {
    routeOwners({}, ['src/file1.txt'], { user: { login: 'some-author' }, labels: labels.map(name => ({ name })) })
    gh.route('GET', '/orgs/Codertocat/members/Codertocat', { status: 204 })
    gh.route('GET', `${repo}/collaborators/Codertocat`, { status: 404, body: { message: 'Not Found' } })
    gh.route('POST', `${repo}/issues/1/comments`, commentWrite)
    gh.route('POST', `${repo}/issues/comments/492700400/reactions`, reactionWrite)
  }

  function routeRuns(runs: Record<string, unknown>[]) {
    gh.route('GET', `${repo}/actions/runs`, { status: 200, body: { total_count: runs.length, workflow_runs: runs } })
  }

  // the Prow run carries the name of the workflow the command runs in, so it is never counted, listed or re-run
  const prow = { id: 3, name: 'Prow', path: '.github/workflows/prow.yml', head_sha: 'headsha', status: 'in_progress', conclusion: null }
  const failedCi = { id: 1, name: 'CI', path: '.github/workflows/ci.yml', head_sha: 'headsha', status: 'completed', conclusion: 'failure' }
  const passedLint = { id: 2, name: 'Lint', path: '.github/workflows/lint.yml', head_sha: 'headsha', status: 'completed', conclusion: 'success' }
  const runningE2e = { id: 4, name: 'E2E', path: '.github/workflows/e2e.yml', head_sha: 'headsha', status: 'in_progress', conclusion: null }
  const pendingE2e = { ...runningE2e, status: 'action_required', conclusion: 'action_required' }

  async function run(command: string, commenter?: string) {
    return runBundle({
      eventName: 'issue_comment',
      payload: prCommentEvent(command, commenter),
      inputs: { ...token, 'prow-commands': command },
      apiUrl: gh.url,
      env: { GITHUB_WORKFLOW: 'Prow' },
    })
  }

  describe('/retest', () => {
    it('with no failed run comments how many are in progress and successful, re-runs nothing and does not react', async () => {
      routeAuthorizedPullRequest()
      routeRuns([passedLint, prow, runningE2e])

      const result = await run('/retest')

      expect(result.status, result.stdout).toBe(0)
      expect(result.errors).toEqual([])
      expectRequests(authReads, [runsRead, commentPost])
      expect(comments()).toEqual(['No failed GitHub Actions workflow runs on `headsha`: 1 in progress, 1 successful. Checks from other CI systems cannot be re-run here.'])
    })

    it('with no run on the head but the current workflow comments without a summary', async () => {
      routeAuthorizedPullRequest()
      routeRuns([prow])

      const result = await run('/retest')

      expect(result.status, result.stdout).toBe(0)
      expect(result.errors).toEqual([])
      expectRequests(authReads, [runsRead, commentPost])
      expect(comments()).toEqual(['No failed GitHub Actions workflow runs on `headsha`. Checks from other CI systems cannot be re-run here.'])
    })

    it('when every failed-jobs re-run answers 409 comments that the runs are already re-running, without a rocket', async () => {
      routeAuthorizedPullRequest()
      routeRuns([failedCi, passedLint, prow])
      gh.route('POST', /\/actions\/runs\/\d+\/rerun-failed-jobs$/, { status: 409, body: { message: 'This workflow is already running' } })

      const result = await run('/retest')

      expect(result.status, result.stdout).toBe(0)
      expect(result.errors).toEqual([])
      expectRequests(authReads, [runsRead, `POST ${repo}/actions/runs/1/rerun-failed-jobs`, commentPost])
      expect(comments()).toEqual(['The failed GitHub Actions workflow runs on `headsha` are already being re-run.'])
    })

    it('when a failed-jobs re-run fails for another reason names the run and fails the action, without a comment', async () => {
      routeAuthorizedPullRequest()
      routeRuns([failedCi, passedLint, prow])
      gh.route('POST', /\/actions\/runs\/\d+\/rerun-failed-jobs$/, boom)

      const result = await run('/retest')

      expect(result.status, result.stdout).toBe(1)
      expect(result.errors).toHaveLength(1)
      expect(result.errors[0]).toMatch(/^TypeError: error handling issue comment: Error: could not re-run CI \(1\): HttpError: boom/)
      expectRequests(authReads, [runsRead, `POST ${repo}/actions/runs/1/rerun-failed-jobs`])
      expect(comments()).toEqual([])
    })

    it('when the runs cannot be listed names the head and fails the action before any re-run', async () => {
      routeAuthorizedPullRequest()
      gh.route('GET', `${repo}/actions/runs`, boom)

      const result = await run('/retest')

      expect(result.status, result.stdout).toBe(1)
      expect(result.errors).toHaveLength(1)
      expect(result.errors[0]).toMatch(/^TypeError: error handling issue comment: Error: could not list the workflow runs of headsha: HttpError: boom/)
      expectRequests(authReads, [runsRead])
      expect(gh.requestsMatching('POST', /\/rerun/)).toEqual([])
    })

    it('when the rocket reaction fails only warns; the re-run still counts as success', async () => {
      routeAuthorizedPullRequest({ reactionWrite: boom })
      routeRuns([failedCi, prow])
      gh.route('POST', /\/actions\/runs\/\d+\/rerun-failed-jobs$/, { status: 201 })

      const result = await run('/retest')

      expect(result.status, result.stdout).toBe(0)
      expect(result.errors).toEqual([])
      expect(result.stdout).toMatch(/::warning::trigger: could not react to the comment: HttpError: boom/)
      expectRequests(authReads, [runsRead, `POST ${repo}/actions/runs/1/rerun-failed-jobs`, rocket])
    })

    it('on an issue that is not a pull request comments that it only applies to pull requests, reading nothing', async () => {
      gh.route('POST', `${repo}/issues/1/comments`, { status: 201, body: {} })

      const result = await runBundle({
        eventName: 'issue_comment',
        payload: comment('/retest'),
        inputs: { ...token, 'prow-commands': '/retest' },
        apiUrl: gh.url,
      })

      expect(result.status, result.stdout).toBe(0)
      expect(result.errors).toEqual([])
      expect(calls()).toEqual([commentPost])
      expect(comments()).toEqual(['`/retest` only applies to pull requests.'])
    })
  })

  describe('/ok-to-test', () => {
    const labelsRead = `GET ${repo}/issues/1`

    it('by the author when the refusal cannot be commented logs that too and still fails the action', async () => {
      routeAuthorizedPullRequest({ commentWrite: boom })

      const result = await run('/ok-to-test', 'some-author')

      expect(result.status, result.stdout).toBe(1)
      expect(result.errors[0]).toContain('you cannot approve the workflow runs of your own pull request')
      expect(result.errors[1]).toMatch(/^Could not comment with an auth error: Error: could not add comment: HttpError: boom/)
      expect(result.errors[2]).toContain('you cannot approve the workflow runs of your own pull request')
      expect(gh.requestsMatching('GET', /\/actions\/runs/)).toEqual([])
    })

    it('on a pull request already carrying ok-to-test with nothing awaiting approval comments so, writes no label and does not react', async () => {
      routeAuthorizedPullRequest({ labels: ['ok-to-test'] })
      routeRuns([passedLint, prow, runningE2e])
      gh.route('GET', `${repo}/issues/1`, { status: 200, body: { labels: [{ name: 'OK-To-Test' }] } })

      const result = await run('/ok-to-test')

      expect(result.status, result.stdout).toBe(0)
      expect(result.errors).toEqual([])
      expectCommandThenConfig([runsRead, labelsRead, commentPost], tail, authReads)
      expect(comments()).toEqual(['No workflow runs waiting for approval on `headsha`.'])
      expect(gh.requestsMatching('POST', /\/issues\/1\/labels$/)).toEqual([])
      expect(gh.requestsMatching('POST', /\/approve$/)).toEqual([])
      expect(gh.requestsMatching('POST', /\/reactions$/)).toEqual([])
    })

    it('when approving a run is forbidden names the permission to grant and fails the action before the label read', async () => {
      routeAuthorizedPullRequest()
      routeRuns([pendingE2e, prow])
      gh.route('POST', /\/actions\/runs\/\d+\/approve$/, { status: 403, body: { message: 'Resource not accessible by integration' } })

      const result = await run('/ok-to-test')

      expect(result.status, result.stdout).toBe(1)
      expect(result.errors[0]).toContain('cannot approve workflow runs: grant `actions: write` to the workflow')
      expectCommandThenConfig([runsRead, `POST ${repo}/actions/runs/4/approve`], tail, authReads)
      expect(gh.requestsMatching('GET', /\/issues\/1$/)).toEqual([])
      expect(gh.requestsMatching('POST', /\/issues\/1\/labels$/)).toEqual([])
      expect(comments()).toEqual([])
    })

    it('when approving a run fails for another reason names the run and fails the action', async () => {
      routeAuthorizedPullRequest()
      routeRuns([pendingE2e, prow])
      gh.route('POST', /\/actions\/runs\/\d+\/approve$/, boom)

      const result = await run('/ok-to-test')

      expect(result.status, result.stdout).toBe(1)
      expect(result.errors[0]).toMatch(/^TypeError: error handling issue comment: Error: could not approve run 4 \(E2E\): HttpError: boom/)
      expectCommandThenConfig([runsRead, `POST ${repo}/actions/runs/4/approve`], tail, authReads)
      expect(gh.requestsMatching('POST', /\/issues\/1\/labels$/)).toEqual([])
    })

    it('on an issue that is not a pull request comments that it only applies to pull requests, then the sweep runs', async () => {
      gh.route('POST', `${repo}/issues/1/comments`, { status: 201, body: {} })

      const result = await runBundle({
        eventName: 'issue_comment',
        payload: comment('/ok-to-test'),
        inputs: { ...token, 'prow-commands': '/ok-to-test' },
        apiUrl: gh.url,
      })

      expect(result.status, result.stdout).toBe(0)
      expect(result.errors).toEqual([])
      expect(calls()[0]).toBe(commentPost)
      expect(comments()).toEqual(['`/ok-to-test` only applies to pull requests.'])
      expect(gh.requestsMatching('GET', /\/actions\/runs/)).toEqual([])
    })
  })
})
