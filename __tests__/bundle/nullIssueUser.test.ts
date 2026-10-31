import type { FakeGithub } from './fakeGithub'
import { Buffer } from 'node:buffer'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import labelFileContents from '../fixtures/labels/labelFileContentsResp.json'
import pullReqOpenedEvent from '../fixtures/pullReq/pullReqOpenedEvent.json'
import { blobSha, prCommentEvent } from '../utils/ownersData'
import { start } from './fakeGithub'
import { comment, configReads, helpersFor, repo, token } from './helpers'
import { runBundle } from './runBundle'

vi.setConfig({ testTimeout: 30_000 })

// GitHub's `issue` schema types `user` as `nullable-simple-user`: the author of an issue whose account was
// deleted comes through as `null`. Every other issue_comment scenario carries a login, so the `?.user?.login`
// reads of /close (src/issueComment/close.ts), /reopen (src/issueComment/reopen.ts) and /approve's
// require_self_approval check (src/issueComment/approve.ts, `?? ''`) never saw the null arm through dist/index.js.
// With no author to match, the commenter is not the author: the collaborator check decides /close and /reopen,
// and require_self_approval does not refuse the /approve.
describe('dist/index.js issue_comment on an issue whose user is null', () => {
  const collaboratorRead = `GET ${repo}/collaborators/Codertocat`
  const issueWrite = `PATCH ${repo}/issues/1`
  let gh: FakeGithub
  const { calls, routeOwners } = helpersFor(() => gh)

  beforeAll(async () => {
    gh = await start()
  })
  beforeEach(() => gh.mergeQueueFallback({ pullRequestId: 'PR_none', headOid: pullReqOpenedEvent.pull_request.head.sha, enabled: false }))
  afterEach(() => gh.reset())
  afterAll(() => gh.close())

  function authorless<T extends { issue: { user: unknown } }>(payload: T): T {
    return { ...payload, issue: { ...payload.issue, user: null } }
  }

  function runIssue(body: string, command: string) {
    return runBundle({
      eventName: 'issue_comment',
      payload: authorless(comment(body)),
      inputs: { ...token, 'prow-commands': command },
      apiUrl: gh.url,
    })
  }

  it('/close by a collaborator: not the author, so the collaborator read decides, then the issue is closed', async () => {
    gh.route('GET', `${repo}/collaborators/Codertocat`, { status: 204 })
    gh.route('PATCH', `${repo}/issues/1`, { status: 200, body: {} })

    const result = await runIssue('/close', '/close')

    expect(result.status, result.stdout).toBe(0)
    expect(result.errors).toEqual([])
    expect(calls()).toEqual([collaboratorRead, issueWrite])
    expect(gh.requestsMatching('PATCH', /\/issues\/1$/)[0].body).toEqual({ state: 'closed' })
  })

  it('/close by a non-collaborator: the refusal reads authorization.close, nothing is closed and the run fails', async () => {
    gh.route('GET', `${repo}/collaborators/Codertocat`, { status: 404, body: { message: 'Not Found' } })

    const result = await runIssue('/close', '/close')

    expect(result.status, result.stdout).toBe(1)
    expect(result.errors.some(e => e.includes('Codertocat is not authorized to close this issue'))).toBe(true)
    expect(calls().slice(0, 1)).toEqual([collaboratorRead])
    expect(calls().slice(1).sort()).toEqual(configReads().sort())
    expect(gh.requestsMatching('PATCH', /./)).toEqual([])
  })

  it('/reopen by a collaborator: not the author, so the collaborator read decides, then the issue is reopened', async () => {
    gh.route('GET', `${repo}/collaborators/Codertocat`, { status: 204 })
    gh.route('PATCH', `${repo}/issues/1`, { status: 200, body: {} })

    const result = await runIssue('/reopen', '/reopen')

    expect(result.status, result.stdout).toBe(0)
    expect(result.errors).toEqual([])
    expect(calls()).toEqual([collaboratorRead, issueWrite])
    expect(gh.requestsMatching('PATCH', /\/issues\/1$/)[0].body).toEqual({ state: 'open' })
  })

  it('/approve with require_self_approval: no author to match, so the approver is not refused and approves', async () => {
    const file = structuredClone(labelFileContents)
    file.content = Buffer.from('approve:\n  require_self_approval: true\n').toString('base64')
    gh.route('GET', `${repo}/contents/.github%2Fprow.yaml`, { status: 200, body: file })
    const owners = { OWNERS: 'approvers:\n- alice\n' }
    gh.route('GET', `${repo}/git/trees/master`, { status: 200, body: { sha: 'master', truncated: false, tree: Object.keys(owners).map(path => ({ path, type: 'blob', sha: blobSha(path) })) } })
    routeOwners(owners, ['x.go'], { user: { login: 'some-author' }, labels: [] })
    gh.route('GET', `${repo}/issues/1/comments`, { status: 200, body: [{ id: 1, body: '/approve', user: { login: 'alice', type: 'User' }, created_at: '2024-01-01T00:00:01Z' }] })
    gh.route('GET', `${repo}/pulls/1/reviews`, { status: 200, body: [] })
    gh.route('GET', `${repo}/labels`, { status: 200, body: [{ name: 'approved' }, { name: 'lgtm' }] })
    gh.route('POST', `${repo}/issues/1/labels`, { status: 200, body: [] })
    gh.route('POST', `${repo}/issues/1/comments`, { status: 201, body: {} })

    const result = await runBundle({
      eventName: 'issue_comment',
      payload: authorless(prCommentEvent('/approve', 'alice')),
      inputs: { ...token, 'prow-commands': '/approve' },
      apiUrl: gh.url,
    })

    expect(result.status, result.stdout).toBe(0)
    expect(result.errors).toEqual([])
    expect(result.stdout).not.toContain('you cannot approve your own PR')
    expect(gh.requestsMatching('POST', /\/issues\/1\/labels$/).map(r => r.body)).toEqual([{ labels: ['approved'] }])
    const notifiers = gh.requestsMatching('POST', /\/issues\/1\/comments$/).map(r => (r.body as { body: string }).body)
    expect(notifiers).toHaveLength(1)
    expect(notifiers[0]).toContain('This pull-request has been approved by: *alice*')
  })
})
