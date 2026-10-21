import type { FakeGithub } from './fakeGithub'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import pullReqOpenedEvent from '../fixtures/pullReq/pullReqOpenedEvent.json'
import { start } from './fakeGithub'
import { comment, helpersFor, repo, token } from './helpers'
import { runBundle } from './runBundle'

vi.setConfig({ testTimeout: 30_000 })

const preload = path.resolve(__dirname, 'nonErrorRejectionPreload.cjs')

// The `e instanceof Error ? e.message : String(e)` arms of the dispatchers and of label-sync's per-label
// write (events.ts:50, handleIssueComment.ts:217, labelSync.ts:107) only run when a client call rejects
// with something that is not an Error. Octokit wraps every fetch rejection in a RequestError, so the
// preload hands the bundle one Response whose `status` getter throws a plain string, the one read that
// @octokit/request makes outside its try/catch. Each path must retain its Error-shaped failure behavior
// and report the string without an unhandled rejection; collaborator checks warn and deny the write.
describe('dist/index.js when an api call rejects with a non-Error value', () => {
  let gh: FakeGithub
  const { calls } = helpersFor(() => gh)

  beforeAll(async () => {
    gh = await start()
  })
  afterEach(() => gh.reset())
  afterAll(() => gh.close())

  function env(target: string) {
    return { NODE_OPTIONS: `--require "${preload}"`, NON_ERROR_REJECT: target }
  }

  describe('pull_request synchronize: runEventHandlers folds the string into the one failure', () => {
    beforeEach(() => gh.mergeQueueFallback({ pullRequestId: 'PR_none', headOid: pullReqOpenedEvent.pull_request.head.sha, enabled: false }))

    it('owners-label\'s pull request read rejects with a string: the step fails naming it and the later handlers still run', async () => {
      const result = await runBundle({
        eventName: 'pull_request',
        payload: { ...pullReqOpenedEvent, action: 'synchronize' },
        inputs: token,
        apiUrl: gh.url,
        env: env(`GET ${repo}/pulls/1`),
      })

      expect(result.status, result.stdout).toBe(1)
      expect(result.errors).toHaveLength(1)
      expect(result.errors[0]).toMatch(/^error handling pull_request event: /)
      expect(result.errors[0]).toContain(`GET ${repo}/pulls/1 rejected with a string, not an Error`)
      expect(result.errors[0]).not.toContain('[object')
      expect(result.stderr).not.toMatch(/Unhandled|unhandledRejection/)
      // the faulted read reached the fake and was recorded like any other
      expect(calls()[0]).toBe(`GET ${repo}/pulls/1`)
    })
  })

  describe('issue_comment: the per-command normalizeError coerces the string', () => {
    it('/milestone\'s milestone list rejects with a string: the step fails with "error handling issue comment: Error: <string>"', async () => {
      gh.route('GET', `${repo}/collaborators/Codertocat`, { status: 204 })
      gh.route('GET', `${repo}/milestones`, { status: 200, body: [{ number: 7, title: 'Sprint 2' }] })

      const result = await runBundle({
        eventName: 'issue_comment',
        payload: comment('/milestone Sprint 2'),
        inputs: { ...token, 'prow-commands': '/milestone' },
        apiUrl: gh.url,
        env: env(`GET ${repo}/milestones`),
      })

      expect(result.status, result.stdout).toBe(1)
      expect(result.errors).toEqual([
        `TypeError: error handling issue comment: Error: GET ${repo}/milestones rejected with a string, not an Error`,
      ])
      expect(result.stderr).not.toMatch(/Unhandled|unhandledRejection/)
      // the milestone is never set once the list is lost
      expect(calls()).toEqual([`GET ${repo}/collaborators/Codertocat`, `GET ${repo}/milestones`])
    })
  })

  describe('workflow_dispatch label-sync: a non-Error write refusal is recorded like an Error one', () => {
    it('the first create rejects with a string: it is logged and recorded, the remaining labels are still created, and the run fails once', async () => {
      gh.route('GET', `${repo}/labels`, { status: 200, body: [] })
      gh.route('POST', `${repo}/labels`, { status: 201, body: {} })

      const result = await runBundle({
        eventName: 'workflow_dispatch',
        payload: {},
        inputs: { ...token, jobs: 'label-sync' },
        apiUrl: gh.url,
        env: env(`POST ${repo}/labels`),
      })

      expect(result.status, result.stdout).toBe(1)
      expect(result.errors).toHaveLength(2)
      expect(result.errors[0]).toBe(`label-sync: could not sync approved: POST ${repo}/labels rejected with a string, not an Error`)
      expect(result.errors[1]).toBe(`TypeError: error handling cron job: Error: 1 label(s) could not be synced: approved (POST ${repo}/labels rejected with a string, not an Error)`)
      expect(result.stderr).not.toMatch(/Unhandled|unhandledRejection/)

      // every other built-in label is still created after the string refusal
      const posts = gh.requestsMatching('POST', /\/labels$/)
      expect(posts.length).toBeGreaterThan(1)
      expect((posts[0].body as { name: string }).name).toBe('approved')
      expect(result.stdout).toContain(`label-sync: created ${posts.length - 1} [`)
      expect(result.stdout).toContain(', unchanged 0, failed 1')
    })
  })

  describe('issue_comment: a non-Error collaborator rejection denies the write', () => {
    it('/retitle warns with the primitive error details and does not update the issue', async () => {
      const collaboratorPath = `${repo}/collaborators/Codertocat`
      const target = `GET ${collaboratorPath}`
      gh.route('GET', collaboratorPath, { status: 204 })
      gh.route('PATCH', `${repo}/issues/1`, { status: 200, body: {} })

      const result = await runBundle({
        eventName: 'issue_comment',
        payload: comment('/retitle A better title'),
        inputs: { ...token, 'prow-commands': '/retitle' },
        apiUrl: gh.url,
        env: env(target),
      })

      expect(result.status, result.stdout).toBe(0)
      expect(result.errors).toEqual([])
      expect(result.stdout.split(/\r?\n/).filter(line => line.startsWith('::warning::'))).toEqual([
        `::warning::encountered unexpected error checking collaborator status: status=unknown, message=${target} rejected with a string, not an Error`,
      ])
      expect(result.stderr).not.toMatch(/Unhandled|unhandledRejection/)
      expect(calls()).toEqual([target])
      expect(gh.requestsMatching('PATCH', /\/issues\/1$/)).toEqual([])
    })
  })
})
