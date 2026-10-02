import type { FakeGithub } from './fakeGithub'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import issueCommentEvent from '../fixtures/issues/issueCommentEvent.json'
import { start } from './fakeGithub'
import { runBundle } from './runBundle'

vi.setConfig({ testTimeout: 30_000 })

// the issue_comment commands that touch assignees, reviewers, title and lock state,
// driven through dist/index.js like the label commands in bundle.test.ts
describe('dist/index.js collaboration commands', () => {
  const repo = '/repos/Codertocat/Hello-World'
  const token = { 'github-token': 'some-token' }
  const collaboratorRead = `GET ${repo}/collaborators/Codertocat`
  let gh: FakeGithub

  beforeAll(async () => {
    gh = await start()
  })
  afterEach(() => gh.reset())
  afterAll(() => gh.close())

  function comment(body: string, author = issueCommentEvent.issue.user.login) {
    const payload = structuredClone(issueCommentEvent)
    payload.comment.body = body
    payload.issue.user.login = author
    return payload
  }

  function calls() {
    return gh.requests.map(r => `${r.method} ${r.path}`)
  }

  async function run(body: string, command: string, author?: string) {
    const result = await runBundle({
      eventName: 'issue_comment',
      payload: comment(body, author),
      inputs: { ...token, 'prow-commands': command },
      apiUrl: gh.url,
    })
    return result
  }

  // the three reads checkCommenterAuth / getOrgCollabCommentUsers make for one user, in order
  function membershipReads(user: string) {
    return [
      `GET /orgs/Codertocat/members/${user}`,
      `GET ${repo}/collaborators/${user}`,
      `GET ${repo}/issues/1/comments`,
    ]
  }

  describe('/cc', () => {
    it('with no arguments requests a review from a collaborator commenter', async () => {
      gh.route('GET', `${repo}/collaborators/Codertocat`, { status: 204 })
      gh.route('POST', `${repo}/pulls/1/requested_reviewers`, { status: 201, body: {} })

      const result = await run('/cc', '/cc')

      expect(result.status, result.stdout).toBe(0)
      expect(result.errors).toEqual([])
      expect(calls()).toEqual([collaboratorRead, `POST ${repo}/pulls/1/requested_reviewers`])
      expect(gh.requestsMatching('POST', /requested_reviewers$/)[0].body).toEqual({ reviewers: ['Codertocat'] })
    })

    it('with no arguments by a non-collaborator makes no review request', async () => {
      gh.route('GET', `${repo}/collaborators/Codertocat`, { status: 404, body: { message: 'Not Found' } })

      const result = await run('/cc', '/cc')

      expect(result.status, result.stdout).toBe(0)
      expect(result.errors).toEqual([])
      expect(calls()).toEqual([collaboratorRead])
    })

    it('requests reviews from the argument users who are org members or have commented, dropping the rest', async () => {
      gh.route('GET', '/orgs/Codertocat/members/octocat', { status: 204 })
      gh.route('GET', `${repo}/collaborators/octocat`, { status: 404, body: { message: 'Not Found' } })
      gh.route('GET', '/orgs/Codertocat/members/stranger', { status: 404, body: { message: 'Not Found' } })
      gh.route('GET', `${repo}/collaborators/stranger`, { status: 404, body: { message: 'Not Found' } })
      gh.route('GET', `${repo}/issues/1/comments`, { status: 200, body: [] })
      gh.route('POST', `${repo}/pulls/1/requested_reviewers`, { status: 201, body: {} })

      const result = await run('/cc @octocat @stranger', '/cc')

      expect(result.status, result.stdout).toBe(0)
      expect(result.errors).toEqual([])
      // the two users are checked concurrently, so their reads interleave
      expect(calls().slice(0, 6).sort()).toEqual([...membershipReads('octocat'), ...membershipReads('stranger')].sort())
      expect(calls().slice(6)).toEqual([`POST ${repo}/pulls/1/requested_reviewers`])
      expect(gh.requestsMatching('POST', /requested_reviewers$/)[0].body).toEqual({ reviewers: ['octocat'] })
    })

    it('fails the action when none of the argument users is authorized', async () => {
      gh.route('GET', '/orgs/Codertocat/members/stranger', { status: 404, body: { message: 'Not Found' } })
      gh.route('GET', `${repo}/collaborators/stranger`, { status: 404, body: { message: 'Not Found' } })
      gh.route('GET', `${repo}/issues/1/comments`, { status: 200, body: [] })

      const result = await run('/cc @stranger', '/cc')

      expect(result.status, result.stdout).toBe(1)
      expect(result.errors.some(e => e.includes('no authorized users found'))).toBe(true)
      expect(gh.requestsMatching('POST', /./)).toEqual([])
    })
  })

  describe('/uncc', () => {
    it('with no arguments removes the collaborator commenter\'s own review request', async () => {
      gh.route('GET', `${repo}/collaborators/Codertocat`, { status: 204 })
      gh.route('DELETE', `${repo}/pulls/1/requested_reviewers`, { status: 200, body: {} })

      const result = await run('/uncc', '/uncc')

      expect(result.status, result.stdout).toBe(0)
      expect(result.errors).toEqual([])
      expect(calls()).toEqual([collaboratorRead, `DELETE ${repo}/pulls/1/requested_reviewers`])
      expect(gh.requestsMatching('DELETE', /requested_reviewers$/)[0].body).toEqual({ reviewers: ['Codertocat'] })
    })

    it('removes the argument users\' review requests when the commenter is an org member', async () => {
      gh.route('GET', '/orgs/Codertocat/members/Codertocat', { status: 204 })
      gh.route('GET', `${repo}/collaborators/Codertocat`, { status: 404, body: { message: 'Not Found' } })
      gh.route('GET', `${repo}/issues/1/comments`, { status: 200, body: [] })
      gh.route('DELETE', `${repo}/pulls/1/requested_reviewers`, { status: 200, body: {} })

      const result = await run('/uncc @octocat @hubot', '/uncc')

      expect(result.status, result.stdout).toBe(0)
      expect(result.errors).toEqual([])
      expect(calls()).toEqual([...membershipReads('Codertocat'), `DELETE ${repo}/pulls/1/requested_reviewers`])
      expect(gh.requestsMatching('DELETE', /requested_reviewers$/)[0].body).toEqual({ reviewers: ['octocat', 'hubot'] })
    })

    it('by an unauthorized commenter with arguments removes nothing', async () => {
      gh.route('GET', '/orgs/Codertocat/members/Codertocat', { status: 404, body: { message: 'Not Found' } })
      gh.route('GET', `${repo}/collaborators/Codertocat`, { status: 404, body: { message: 'Not Found' } })
      gh.route('GET', `${repo}/issues/1/comments`, { status: 200, body: [] })

      const result = await run('/uncc @octocat', '/uncc')

      expect(result.status, result.stdout).toBe(0)
      expect(result.errors).toEqual([])
      expect(calls()).toEqual(membershipReads('Codertocat'))
    })
  })

  describe('/unassign', () => {
    it('with no arguments unassigns the commenter without any authorization read', async () => {
      gh.route('DELETE', `${repo}/issues/1/assignees`, { status: 200, body: {} })

      const result = await run('/unassign', '/unassign')

      expect(result.status, result.stdout).toBe(0)
      expect(result.errors).toEqual([])
      expect(calls()).toEqual([`DELETE ${repo}/issues/1/assignees`])
      expect(gh.requestsMatching('DELETE', /assignees$/)[0].body).toEqual({ assignees: ['Codertocat'] })
    })

    it('unassigns the argument users when the commenter has commented on the issue before', async () => {
      gh.route('GET', '/orgs/Codertocat/members/Codertocat', { status: 404, body: { message: 'Not Found' } })
      gh.route('GET', `${repo}/collaborators/Codertocat`, { status: 404, body: { message: 'Not Found' } })
      gh.route('GET', `${repo}/issues/1/comments`, { status: 200, body: [{ user: { login: 'Codertocat' } }] })
      gh.route('DELETE', `${repo}/issues/1/assignees`, { status: 200, body: {} })

      const result = await run('/unassign @octocat', '/unassign')

      expect(result.status, result.stdout).toBe(0)
      expect(result.errors).toEqual([])
      expect(calls()).toEqual([...membershipReads('Codertocat'), `DELETE ${repo}/issues/1/assignees`])
      expect(gh.requestsMatching('DELETE', /assignees$/)[0].body).toEqual({ assignees: ['octocat'] })
    })

    it('fails the action when the assignee removal is refused', async () => {
      gh.route('DELETE', `${repo}/issues/1/assignees`, { status: 500, body: { message: 'boom' } })

      const result = await run('/unassign', '/unassign')

      expect(result.status, result.stdout).toBe(1)
      expect(result.errors.some(e => e.includes('could not remove assignee'))).toBe(true)
    })
  })

  describe('/retitle', () => {
    it('by a collaborator sets the rest of the line as the new title', async () => {
      gh.route('GET', `${repo}/collaborators/Codertocat`, { status: 204 })
      gh.route('PATCH', `${repo}/issues/1`, { status: 200, body: {} })

      const result = await run('/retitle A much better title: with punctuation', '/retitle')

      expect(result.status, result.stdout).toBe(0)
      expect(result.errors).toEqual([])
      expect(calls()).toEqual([collaboratorRead, `PATCH ${repo}/issues/1`])
      expect(gh.requestsMatching('PATCH', /\/issues\/1$/)[0].body).toEqual({ title: 'A much better title: with punctuation' })
    })

    it('by a non-collaborator changes nothing', async () => {
      gh.route('GET', `${repo}/collaborators/Codertocat`, { status: 404, body: { message: 'Not Found' } })

      const result = await run('/retitle Sneaky', '/retitle')

      expect(result.status, result.stdout).toBe(0)
      expect(result.errors).toEqual([])
      expect(calls()).toEqual([collaboratorRead])
    })

    it('without a title calls the api not at all', async () => {
      const result = await run('/retitle', '/retitle')

      expect(result.status, result.stdout).toBe(0)
      expect(result.errors).toEqual([])
      expect(calls()).toEqual([])
    })
  })

  describe('/lock', () => {
    it('by a collaborator locks without a reason', async () => {
      gh.route('GET', `${repo}/collaborators/Codertocat`, { status: 204 })
      gh.route('PUT', `${repo}/issues/1/lock`, { status: 204 })

      const result = await run('/lock', '/lock')

      expect(result.status, result.stdout).toBe(0)
      expect(result.errors).toEqual([])
      expect(calls()).toEqual([collaboratorRead, `PUT ${repo}/issues/1/lock`])
      expect(gh.requestsMatching('PUT', /lock$/)[0].body).toBeUndefined()
    })

    it('maps too-heated to the api lock_reason "too heated"', async () => {
      gh.route('GET', `${repo}/collaborators/Codertocat`, { status: 204 })
      gh.route('PUT', `${repo}/issues/1/lock`, { status: 204 })

      const result = await run('/lock too-heated', '/lock')

      expect(result.status, result.stdout).toBe(0)
      expect(result.errors).toEqual([])
      expect(gh.requestsMatching('PUT', /lock$/)[0].body).toEqual({ lock_reason: 'too heated' })
    })

    it('with an unknown reason fails the action before locking', async () => {
      gh.route('GET', `${repo}/collaborators/Codertocat`, { status: 204 })

      const result = await run('/lock because', '/lock')

      expect(result.status, result.stdout).toBe(1)
      expect(result.errors.some(e => e.includes('unknown reason "because"'))).toBe(true)
      expect(calls()).toEqual([collaboratorRead])
    })

    it('by a non-collaborator fails the action and does not lock', async () => {
      gh.route('GET', `${repo}/collaborators/Codertocat`, { status: 404, body: { message: 'Not Found' } })

      const result = await run('/lock spam', '/lock')

      expect(result.status, result.stdout).toBe(1)
      expect(result.errors.some(e => e.includes('commenter is not a collaborator user'))).toBe(true)
      expect(calls()).toEqual([collaboratorRead])
    })
  })

  describe('/reopen', () => {
    it('by the issue author reopens without a collaborator read', async () => {
      gh.route('PATCH', `${repo}/issues/1`, { status: 200, body: {} })

      const result = await run('/reopen', '/reopen')

      expect(result.status, result.stdout).toBe(0)
      expect(result.errors).toEqual([])
      expect(calls()).toEqual([`PATCH ${repo}/issues/1`])
      expect(gh.requestsMatching('PATCH', /\/issues\/1$/)[0].body).toEqual({ state: 'open' })
    })

    it('by a collaborator who is not the author reopens after the collaborator read', async () => {
      gh.route('GET', `${repo}/collaborators/Codertocat`, { status: 204 })
      gh.route('PATCH', `${repo}/issues/1`, { status: 200, body: {} })

      const result = await run('/reopen', '/reopen', 'some-author')

      expect(result.status, result.stdout).toBe(0)
      expect(result.errors).toEqual([])
      expect(calls()).toEqual([collaboratorRead, `PATCH ${repo}/issues/1`])
    })

    it('by a non-collaborator non-author is a silent no-op', async () => {
      gh.route('GET', `${repo}/collaborators/Codertocat`, { status: 404, body: { message: 'Not Found' } })

      const result = await run('/reopen', '/reopen', 'some-author')

      expect(result.status, result.stdout).toBe(0)
      expect(result.errors).toEqual([])
      expect(calls()).toEqual([collaboratorRead])
    })
  })

  it('one body carrying /retitle and /lock runs both commands', async () => {
    gh.route('GET', `${repo}/collaborators/Codertocat`, { status: 204 })
    gh.route('PATCH', `${repo}/issues/1`, { status: 200, body: {} })
    gh.route('PUT', `${repo}/issues/1/lock`, { status: 204 })

    const result = await run('/retitle Resolved upstream\n/lock resolved', '/retitle /lock')

    expect(result.status, result.stdout).toBe(0)
    expect(result.errors).toEqual([])
    expect(gh.requestsMatching('PATCH', /\/issues\/1$/)[0].body).toEqual({ title: 'Resolved upstream' })
    expect(gh.requestsMatching('PUT', /lock$/)[0].body).toEqual({ lock_reason: 'resolved' })
  })
})
