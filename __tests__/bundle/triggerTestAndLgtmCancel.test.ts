import type { FakeGithub } from './fakeGithub'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import issueCommentEvent from '../fixtures/issues/issueCommentEvent.json'
import pullReqOpenedEvent from '../fixtures/pullReq/pullReqOpenedEvent.json'
import { prCommentEvent } from '../utils/ownersData'
import { start } from './fakeGithub'
import { configReads, helpersFor, membershipReads, ownersProbe, ownersReads, queueRead, repo, token } from './helpers'
import { runBundle } from './runBundle'

vi.setConfig({ testTimeout: 30_000 })

// the /test trigger command and the lgtm cancel spellings (/lgtm cancel, /remove-lgtm),
// driven through dist/index.js like /retest and /lgtm in bundle.test.ts
describe('dist/index.js /test and lgtm cancel', () => {
  const commentPost = `POST ${repo}/issues/1/comments`
  const rocket = `POST ${repo}/issues/comments/492700400/reactions`
  const runsRead = `GET ${repo}/actions/runs?head_sha=headsha&per_page=100`
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

  // the pull request, its files and an OWNERS-less base tree: the commenter is then authorized by membership
  function routePullRequest(labels: string[] = []) {
    routeOwners({}, ['src/file1.txt'], { user: { login: 'some-author' }, labels: labels.map(name => ({ name })) })
  }

  function routeMember(login: string, member: boolean) {
    gh.route('GET', `/orgs/Codertocat/members/${login}`, member ? { status: 204 } : { status: 404, body: { message: 'Not Found' } })
    gh.route('GET', `${repo}/collaborators/${login}`, { status: 404, body: { message: 'Not Found' } })
  }

  // the OWNERS-less authorization of a reviewer: owners reads, then org membership and collaborator (unordered among themselves)
  function expectAuthorized(rest: string[], login = 'Codertocat') {
    expectRequests([...ownersReads, ...membershipReads(login)], rest)
  }

  describe('/test', () => {
    // the Prow run carries the name of the workflow this command runs in, so it is never listed or re-run
    const runsOnHead = {
      total_count: 4,
      workflow_runs: [
        { id: 1, name: 'CI', path: '.github/workflows/ci.yml', head_sha: 'headsha', status: 'completed', conclusion: 'failure' },
        { id: 2, name: 'Lint', path: '.github/workflows/lint.yml', head_sha: 'headsha', status: 'completed', conclusion: 'success' },
        { id: 3, name: 'Prow', path: '.github/workflows/prow.yml', head_sha: 'headsha', status: 'in_progress', conclusion: null },
        { id: 4, name: 'E2E', path: '.github/workflows/e2e.yml', head_sha: 'headsha', status: 'in_progress', conclusion: null },
      ],
    }

    function routeTest() {
      routePullRequest()
      routeMember('Codertocat', true)
      gh.route('GET', `${repo}/actions/runs`, { status: 200, body: runsOnHead })
      gh.route('POST', /\/actions\/runs\/\d+\/rerun$/, { status: 201 })
      gh.route('POST', `${repo}/issues/1/comments`, { status: 201, body: {} })
      gh.route('POST', `${repo}/issues/comments/492700400/reactions`, { status: 201, body: { content: 'rocket' } })
    }

    async function runTest(body: string, commenter?: string) {
      return runBundle({
        eventName: 'issue_comment',
        payload: prCommentEvent(body, commenter),
        inputs: { ...token, 'prow-commands': '/test' },
        apiUrl: gh.url,
        env: { GITHUB_WORKFLOW: 'Prow' },
      })
    }

    const table = [
      'Workflow runs on `headsha`:',
      '',
      'workflow | status | conclusion',
      '--- | --- | ---',
      '`CI` | completed | failure',
      '`Lint` | completed | success',
      '`E2E` | in_progress | ',
    ].join('\n')

    it('with no argument lists the runs on the head, minus the current workflow, and re-runs nothing', async () => {
      routeTest()

      const result = await runTest('/test')

      expect(result.status, result.stdout).toBe(0)
      expect(result.errors).toEqual([])
      expectAuthorized([runsRead, commentPost])
      expect(comments()).toEqual([table])
    })

    it('? lists the runs the same way', async () => {
      routeTest()

      const result = await runTest('/test ?')

      expect(result.status, result.stdout).toBe(0)
      expect(result.errors).toEqual([])
      expectAuthorized([runsRead, commentPost])
      expect(comments()).toEqual([table])
    })

    it('all re-runs every completed run, in progress ones left alone, then reacts with a rocket; no sweep follows', async () => {
      routeTest()

      const result = await runTest('/test all')

      expect(result.status, result.stdout).toBe(0)
      expect(result.errors).toEqual([])
      expectAuthorized([runsRead, `POST ${repo}/actions/runs/1/rerun`, `POST ${repo}/actions/runs/2/rerun`, rocket])
      expect(gh.requestsMatching('POST', /\/reactions$/)[0].body).toEqual({ content: 'rocket' })
      expect(comments()).toEqual([])
    })

    it('<name> re-runs the completed run whose workflow name matches, case-insensitively', async () => {
      routeTest()

      const result = await runTest('/test LINT')

      expect(result.status, result.stdout).toBe(0)
      expect(result.errors).toEqual([])
      expectAuthorized([runsRead, `POST ${repo}/actions/runs/2/rerun`, rocket])
    })

    it('<file> re-runs the completed run whose workflow file matches, with or without the extension', async () => {
      routeTest()

      const result = await runTest('/test ci')

      expect(result.status, result.stdout).toBe(0)
      expect(result.errors).toEqual([])
      expectAuthorized([runsRead, `POST ${repo}/actions/runs/1/rerun`, rocket])
    })

    it('<name> matching only an in-progress run comments the table of runs and re-runs nothing', async () => {
      routeTest()

      const result = await runTest('/test e2e')

      expect(result.status, result.stdout).toBe(0)
      expect(result.errors).toEqual([])
      expectAuthorized([runsRead, commentPost])
      expect(comments()).toEqual([`No completed GitHub Actions workflow run on \`headsha\` matches \`e2e\`.\n\n${table}`])
    })

    it('all when every re-run answers 409 comments that the runs are already re-running, without a rocket', async () => {
      routeTest()
      gh.reset()
      routePullRequest()
      routeMember('Codertocat', true)
      gh.route('GET', `${repo}/actions/runs`, { status: 200, body: runsOnHead })
      gh.route('POST', /\/actions\/runs\/\d+\/rerun$/, { status: 409, body: { message: 'This workflow is already running' } })
      gh.route('POST', `${repo}/issues/1/comments`, { status: 201, body: {} })

      const result = await runTest('/test all')

      expect(result.status, result.stdout).toBe(0)
      expect(result.errors).toEqual([])
      expectAuthorized([runsRead, `POST ${repo}/actions/runs/1/rerun`, `POST ${repo}/actions/runs/2/rerun`, commentPost])
      expect(comments()).toEqual(['The GitHub Actions workflow runs on `headsha` are already being re-run.'])
    })

    it('all when the re-run is forbidden names the permission to grant, comments it and fails the run', async () => {
      routePullRequest()
      routeMember('Codertocat', true)
      gh.route('GET', `${repo}/actions/runs`, { status: 200, body: runsOnHead })
      gh.route('POST', /\/actions\/runs\/\d+\/rerun$/, { status: 403, body: { message: 'Resource not accessible by integration' } })
      gh.route('POST', `${repo}/issues/1/comments`, { status: 201, body: {} })

      const result = await runTest('/test all')

      expect(result.status, result.stdout).toBe(1)
      // the refusal is logged as an error, then the run fails with it
      expect(result.errors).toEqual([
        'cannot re-run workflows: grant `actions: write` to the workflow',
        'TypeError: error handling issue comment: Error: cannot re-run workflows: grant `actions: write` to the workflow',
      ])
      expectAuthorized([runsRead, `POST ${repo}/actions/runs/1/rerun`, commentPost])
      expect(comments()).toEqual(['cannot re-run workflows: grant `actions: write` to the workflow'])
    })

    it('by a commenter who is neither owner, member nor collaborator is refused with a comment and fails the run', async () => {
      routePullRequest()
      routeMember('stranger', false)
      gh.route('POST', `${repo}/issues/1/comments`, { status: 201, body: {} })

      const result = await runTest('/test all', 'stranger')

      expect(result.status, result.stdout).toBe(1)
      expect(result.errors).toEqual([
        'Cannot /test because Error: stranger is not a org member or collaborator',
        'TypeError: error handling issue comment: Error: stranger is not a org member or collaborator',
      ])
      // only the refusal reads authorization.review, after the owners and membership reads
      expectRequests([...ownersReads, ...membershipReads('stranger'), ...configReads()], [commentPost])
      expect(calls().slice(0, ownersReads.length + 2).sort()).toEqual([...ownersReads, ...membershipReads('stranger')].sort())
      expect(comments()).toEqual(['Cannot /test because Error: stranger is not a org member or collaborator'])
      expect(gh.requestsMatching('GET', /\/actions\/runs/)).toEqual([])
    })

    it('on an issue that is not a pull request comments that it only applies to pull requests, reading nothing', async () => {
      gh.route('POST', `${repo}/issues/1/comments`, { status: 201, body: {} })

      const result = await runBundle({
        eventName: 'issue_comment',
        payload: { ...structuredClone(issueCommentEvent), comment: { ...issueCommentEvent.comment, body: '/test all' } },
        inputs: { ...token, 'prow-commands': '/test' },
        apiUrl: gh.url,
      })

      expect(result.status, result.stdout).toBe(0)
      expect(result.errors).toEqual([])
      expect(calls()).toEqual([commentPost])
      expect(comments()).toEqual(['`/test` only applies to pull requests.'])
    })
  })

  describe('lgtm cancel', () => {
    const labelsRead = `GET ${repo}/issues/1`
    const unlabel = `DELETE ${repo}/issues/1/labels/lgtm`
    const unbind = `POST ${repo}/statuses/headsha`
    const pullRead = `GET ${repo}/pulls/1`
    // tide's sweep: the pr (now without lgtm), whether its base has OWNERS files, and the merge queue state
    const sweep = [pullRead, ownersProbe, queueRead]

    // the issue read answers with `labels`; the pull request read (before and after the removal) never carries lgtm,
    // as tide's sweep would see it once the label is gone
    function routeCancel(labels: string[]) {
      routePullRequest()
      gh.route('GET', `${repo}/issues/1`, { status: 200, body: { labels: labels.map(name => ({ name })) } })
      gh.route('DELETE', `${repo}/issues/1/labels/lgtm`, { status: 200, body: [] })
      gh.route('POST', `${repo}/statuses/headsha`, { status: 201, body: {} })
    }

    async function runCancel(body: string, commenter?: string) {
      return runBundle({
        eventName: 'issue_comment',
        payload: prCommentEvent(body, commenter),
        inputs: { ...token, 'prow-commands': '/lgtm' },
        apiUrl: gh.url,
      })
    }

    it('/lgtm cancel by a reviewer on an lgtm\'d pr: removes the label, voids the binding with a pending status, and the sweep skips the pr', async () => {
      routeCancel(['lgtm'])
      routeMember('Codertocat', true)

      const result = await runCancel('/lgtm cancel')

      expect(result.status, result.stdout).toBe(0)
      expect(result.errors).toEqual([])
      expect(result.stdout).toContain('skipping pr #1: missing lgtm')
      expect(gh.requestsMatching('POST', /\/statuses\/headsha$/)[0].body).toEqual({ state: 'pending', context: 'prow/lgtm', description: 'lgtm cancelled by Codertocat' })
      expect(gh.requestsMatching('PUT', /./)).toEqual([])
      // the reviewer is authorized (owners reads, membership), the label read and removed, the configuration read for the
      // binding setting, the head (already read) unbound, then the sweep
      expectCommandThenConfig([labelsRead, unlabel], [unbind, ...sweep], [...ownersReads, ...membershipReads('Codertocat')])
    })

    it('/remove-lgtm by the pr author needs no membership: removes the label and voids the binding', async () => {
      routeCancel(['lgtm'])

      const result = await runCancel('/remove-lgtm', 'some-author')

      expect(result.status, result.stdout).toBe(0)
      expect(result.errors).toEqual([])
      expect(result.stdout).toContain('skipping pr #1: missing lgtm')
      expect(gh.requestsMatching('POST', /\/statuses\/headsha$/)[0].body).toEqual({ state: 'pending', context: 'prow/lgtm', description: 'lgtm cancelled by some-author' })
      expect(gh.requestsMatching('GET', /\/orgs\/|\/collaborators\//)).toEqual([])
      // no authorization read: the label read and removed, the configuration read, then the pr and its OWNERS context read
      // for the head (the same reads the authorization would have made), the head unbound, then the sweep
      expectCommandThenConfig([labelsRead, unlabel], [...ownersReads, unbind, ...sweep], [])
    })

    it('/lgtm cancel on a pr without the label removes nothing and writes no status', async () => {
      routeCancel([])
      routeMember('Codertocat', true)

      const result = await runCancel('/lgtm cancel')

      expect(result.status, result.stdout).toBe(0)
      expect(result.errors).toEqual([])
      expect(gh.requestsMatching('DELETE', /./)).toEqual([])
      expect(gh.requestsMatching('POST', /\/statuses\//)).toEqual([])
    })

    it('/lgtm cancel by a commenter who is neither author nor reviewer is refused and removes nothing', async () => {
      routeCancel(['lgtm'])
      routeMember('stranger', false)
      gh.route('POST', `${repo}/issues/1/comments`, { status: 201, body: {} })

      const result = await runCancel('/lgtm cancel', 'stranger')

      expect(result.status, result.stdout).toBe(1)
      expect(result.errors.some(e => /stranger is not a org member or collaborator/.test(e))).toBe(true)
      expect(gh.requestsMatching('DELETE', /./)).toEqual([])
      expect(gh.requestsMatching('POST', /\/statuses\//)).toEqual([])
    })
  })
})
