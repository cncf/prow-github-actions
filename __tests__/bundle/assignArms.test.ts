import type { FakeGithub } from './fakeGithub'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { start } from './fakeGithub'
import { comment, commentsRead, helpersFor, memberReads, membershipReads, repo, token } from './helpers'
import { runBundle } from './runBundle'

vi.setConfig({ testTimeout: 30_000 })

// the /assign failure arms, driven through dist/index.js: the happy paths (self-assign, argument users) live in
// bundle.test.ts. The authorization helpers swallow their own API errors, so the only arms reachable over HTTP
// are the refused writes and the empty authorized set
describe('dist/index.js /assign failure arms', () => {
  const assigneesWrite = `POST ${repo}/issues/1/assignees`
  let gh: FakeGithub
  const { calls } = helpersFor(() => gh)

  beforeAll(async () => {
    gh = await start()
  })
  afterEach(() => gh.reset())
  afterAll(() => gh.close())

  async function run(body: string) {
    return runBundle({
      eventName: 'issue_comment',
      payload: comment(body),
      inputs: { ...token, 'prow-commands': '/assign' },
      apiUrl: gh.url,
    })
  }

  // the reads checkCommenterAuth / getOrgCollabCommentUsers make for one user that is neither an org member nor a
  // collaborator, in order; the comment thread is read once per run however many users need it
  function membershipOrCommentReads(user: string) {
    return [...membershipReads(user), commentsRead]
  }

  it('fails the action when the self-assign write is refused', async () => {
    gh.route('GET', `${repo}/collaborators/Codertocat`, { status: 204 })
    gh.route('POST', `${repo}/issues/1/assignees`, { status: 500, body: { message: 'boom' } })

    const result = await run('/assign')

    expect(result.status, result.stdout).toBe(1)
    expect(result.errors.some(e => e.includes('could not self assign'))).toBe(true)
    // the collaborator read admits the commenter: no comment-thread read
    expect(calls()).toEqual([...membershipReads('Codertocat'), assigneesWrite])
    expect(gh.requestsMatching('POST', /assignees$/)[0].body).toEqual({ assignees: ['Codertocat'] })
  })

  it('fails the action when none of the argument users is authorized, without writing', async () => {
    gh.route('GET', `${repo}/issues/1/comments`, { status: 200, body: [] })

    const result = await run('/assign @stranger @drifter')

    expect(result.status, result.stdout).toBe(1)
    expect(result.errors.some(e => e.includes('no authorized users found'))).toBe(true)
    expect(gh.requestsMatching('POST', /./)).toEqual([])
    // the two users are authorized concurrently, so their reads have no fixed order among themselves
    expect(calls().sort()).toEqual([...membershipReads('stranger'), ...membershipOrCommentReads('drifter')].sort())
  })

  it('fails the action when the argument users\' assignee write is refused', async () => {
    gh.route('GET', '/orgs/Codertocat/members/octocat', { status: 204 })
    gh.route('GET', `${repo}/collaborators/octocat`, { status: 404, body: { message: 'Not Found' } })
    gh.route('GET', `${repo}/issues/1/comments`, { status: 200, body: [] })
    gh.route('POST', `${repo}/issues/1/assignees`, { status: 500, body: { message: 'boom' } })

    const result = await run('/assign @octocat')

    expect(result.status, result.stdout).toBe(1)
    expect(result.errors.some(e => e.includes('could not add assignees'))).toBe(true)
    // membership admits octocat: no collaborator or comment-thread read
    expect(calls()).toEqual([...memberReads('octocat'), assigneesWrite])
    expect(gh.requestsMatching('POST', /assignees$/)[0].body).toEqual({ assignees: ['octocat'] })
  })
})
