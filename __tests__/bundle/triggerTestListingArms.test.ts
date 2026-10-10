import type { FakeGithub } from './fakeGithub'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import pullReqOpenedEvent from '../fixtures/pullReq/pullReqOpenedEvent.json'
import { prCommentEvent } from '../utils/ownersData'
import { start } from './fakeGithub'
import { helpersFor, membershipReads, ownersReads, repo, token } from './helpers'
import { runBundle } from './runBundle'

vi.setConfig({ testTimeout: 30_000 })

// the /test listing and matching arms that depend on the shape of the run list:
// a head with no run at all (the `_none_` row of runTable) and a run whose
// `name` is null, which the API schema allows (workflow-run.name: string | null)
// and which matchesWorkflow and runTable fall back to the workflow path for
describe('dist/index.js /test listing arms', () => {
  const commentPost = `POST ${repo}/issues/1/comments`
  const rocket = `POST ${repo}/issues/comments/492700400/reactions`
  const runsRead = `GET ${repo}/actions/runs?head_sha=headsha&per_page=100`
  let gh: FakeGithub
  const { expectRequests, routeOwners } = helpersFor(() => gh)

  beforeAll(async () => {
    gh = await start()
  })
  beforeEach(() => gh.mergeQueueFallback({ pullRequestId: 'PR_none', headOid: pullReqOpenedEvent.pull_request.head.sha, enabled: false }))
  afterEach(() => gh.reset())
  afterAll(() => gh.close())

  function comments() {
    return gh.requestsMatching('POST', /\/issues\/1\/comments$/).map(r => (r.body as { body: string }).body)
  }

  function routeTest(runs: Record<string, unknown>[]) {
    routeOwners({}, ['src/file1.txt'], { user: { login: 'some-author' }, labels: [] })
    gh.route('GET', '/orgs/Codertocat/members/Codertocat', { status: 204 })
    gh.route('GET', `${repo}/collaborators/Codertocat`, { status: 404, body: { message: 'Not Found' } })
    gh.route('GET', `${repo}/actions/runs`, { status: 200, body: { total_count: runs.length, workflow_runs: runs } })
    gh.route('POST', /\/actions\/runs\/\d+\/rerun$/, { status: 201 })
    gh.route('POST', `${repo}/issues/1/comments`, { status: 201, body: {} })
    gh.route('POST', `${repo}/issues/comments/492700400/reactions`, { status: 201, body: { content: 'rocket' } })
  }

  function runTest(body: string) {
    return runBundle({
      eventName: 'issue_comment',
      payload: prCommentEvent(body),
      inputs: { ...token, 'prow-commands': '/test' },
      apiUrl: gh.url,
      env: { GITHUB_WORKFLOW: 'Prow' },
    })
  }

  function expectAuthorized(rest: string[]) {
    expectRequests([...ownersReads, ...membershipReads('Codertocat')], rest)
  }

  const header = [
    'Workflow runs on `headsha`:',
    '',
    'workflow | status | conclusion',
    '--- | --- | ---',
  ]

  // only the Prow run itself is on the head, and headRuns drops it as the current workflow
  const onlyTheCurrentWorkflow = [
    { id: 3, name: 'Prow', path: '.github/workflows/prow.yml', head_sha: 'headsha', status: 'in_progress', conclusion: null },
  ]

  const namelessRuns = [
    { id: 1, name: null, path: '.github/workflows/ci.yml', head_sha: 'headsha', status: 'completed', conclusion: 'failure' },
    { id: 3, name: 'Prow', path: '.github/workflows/prow.yml', head_sha: 'headsha', status: 'in_progress', conclusion: null },
  ]

  it('with no run on the head besides the current workflow lists a `_none_` row and re-runs nothing', async () => {
    routeTest(onlyTheCurrentWorkflow)

    const result = await runTest('/test')

    expect(result.status, result.stdout).toBe(0)
    expect(result.errors).toEqual([])
    expectAuthorized([runsRead, commentPost])
    expect(comments()).toEqual([[...header, '_none_ | |'].join('\n')])
  })

  it('all with no run on the head says no completed run matches and lists the `_none_` row', async () => {
    routeTest(onlyTheCurrentWorkflow)

    const result = await runTest('/test all')

    expect(result.status, result.stdout).toBe(0)
    expect(result.errors).toEqual([])
    expectAuthorized([runsRead, commentPost])
    expect(comments()).toEqual([`No completed GitHub Actions workflow run on \`headsha\` matches \`all\`.\n\n${[...header, '_none_ | |'].join('\n')}`])
  })

  it('? lists a run without a name by its workflow path', async () => {
    routeTest(namelessRuns)

    const result = await runTest('/test ?')

    expect(result.status, result.stdout).toBe(0)
    expect(result.errors).toEqual([])
    expectAuthorized([runsRead, commentPost])
    expect(comments()).toEqual([[...header, '`.github/workflows/ci.yml` | completed | failure'].join('\n')])
  })

  it('<file> re-runs a completed run without a name when its workflow file matches, then reacts with a rocket', async () => {
    routeTest(namelessRuns)

    const result = await runTest('/test ci.yml')

    expect(result.status, result.stdout).toBe(0)
    expect(result.errors).toEqual([])
    expectAuthorized([runsRead, `POST ${repo}/actions/runs/1/rerun`, rocket])
    expect(comments()).toEqual([])
  })

  it('<name> that matches neither the path of a nameless run comments the table naming it by path', async () => {
    routeTest(namelessRuns)

    const result = await runTest('/test lint')

    expect(result.status, result.stdout).toBe(0)
    expect(result.errors).toEqual([])
    expectAuthorized([runsRead, commentPost])
    expect(comments()).toEqual([`No completed GitHub Actions workflow run on \`headsha\` matches \`lint\`.\n\n${[...header, '`.github/workflows/ci.yml` | completed | failure'].join('\n')}`])
  })
})
