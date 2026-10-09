import type { FakeGithub } from './fakeGithub'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import pullReqOpenedEvent from '../fixtures/pullReq/pullReqOpenedEvent.json'
import { prCommentEvent } from '../utils/ownersFixtures'
import { start } from './fakeGithub'
import { helpersFor, membershipReads, ownersReads, repo, token } from './helpers'
import { runBundle } from './runBundle'

vi.setConfig({ testTimeout: 30_000 })

// the arm of src/issueComment/trigger.ts react() that triggerArms.test.ts leaves out: an issue_comment
// payload whose `comment` carries no `id` cannot be reacted to, so a successful re-run ends without
// the rocket and without failing; the command itself needs only `comment.body` and `comment.user.login`
describe('dist/index.js /retest reaction guard', () => {
  const runsRead = `GET ${repo}/actions/runs?head_sha=headsha&per_page=100`
  const rerun = `POST ${repo}/actions/runs/1/rerun-failed-jobs`
  const authReads = [...ownersReads, ...membershipReads('Codertocat')]
  let gh: FakeGithub
  const { expectRequests, routeOwners } = helpersFor(() => gh)

  beforeAll(async () => {
    gh = await start()
  })
  beforeEach(() => gh.mergeQueueFallback({ pullRequestId: 'PR_none', headOid: pullReqOpenedEvent.pull_request.head.sha, enabled: false }))
  afterEach(() => gh.reset())
  afterAll(() => gh.close())

  const prow = { id: 3, name: 'Prow', path: '.github/workflows/prow.yml', head_sha: 'headsha', status: 'in_progress', conclusion: null }
  const failedCi = { id: 1, name: 'CI', path: '.github/workflows/ci.yml', head_sha: 'headsha', status: 'completed', conclusion: 'failure' }

  it('re-runs the failed run and exits 0 without a reaction when the comment payload has no id', async () => {
    routeOwners({}, ['src/file1.txt'], { user: { login: 'some-author' } })
    gh.route('GET', '/orgs/Codertocat/members/Codertocat', { status: 204 })
    gh.route('GET', `${repo}/collaborators/Codertocat`, { status: 404, body: { message: 'Not Found' } })
    gh.route('GET', `${repo}/actions/runs`, { status: 200, body: { total_count: 2, workflow_runs: [failedCi, prow] } })
    gh.route('POST', /\/actions\/runs\/\d+\/rerun-failed-jobs$/, { status: 201 })

    const event = prCommentEvent('/retest')
    const { id: _id, ...commentWithoutId } = event.comment
    const payload = { ...event, comment: commentWithoutId }

    const result = await runBundle({
      eventName: 'issue_comment',
      payload,
      inputs: { ...token, 'prow-commands': '/retest' },
      apiUrl: gh.url,
      env: { GITHUB_WORKFLOW: 'Prow' },
    })

    expect(result.status, result.stdout).toBe(0)
    expect(result.errors).toEqual([])
    expect(result.stdout).not.toMatch(/could not react to the comment/)
    expectRequests(authReads, [runsRead, rerun])
    expect(gh.requestsMatching('POST', /\/reactions$/)).toEqual([])
  })
})
