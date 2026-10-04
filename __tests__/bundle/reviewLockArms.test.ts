import type { FakeGithub } from './fakeGithub'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { start } from './fakeGithub'
import { comment, helpersFor, membershipReads, repo, token } from './helpers'
import { runBundle } from './runBundle'

vi.setConfig({ testTimeout: 30_000 })

// the refused-write arms of /cc, /uncc, /lock and /unassign, driven through dist/index.js: each command wraps
// its GitHub write in its own error message, and the happy paths live in collaborationCommands.test.ts
describe('dist/index.js review and lock command refused writes', () => {
  const collaboratorRead = `GET ${repo}/collaborators/Codertocat`
  let gh: FakeGithub
  const { calls } = helpersFor(() => gh)

  beforeAll(async () => {
    gh = await start()
  })
  afterEach(() => gh.reset())
  afterAll(() => gh.close())

  async function run(body: string, command: string) {
    return runBundle({
      eventName: 'issue_comment',
      payload: comment(body),
      inputs: { ...token, 'prow-commands': command },
      apiUrl: gh.url,
    })
  }

  describe('/cc', () => {
    it('fails the action when the self review request is refused', async () => {
      gh.route('GET', `${repo}/collaborators/Codertocat`, { status: 204 })
      gh.route('POST', `${repo}/pulls/1/requested_reviewers`, { status: 500, body: { message: 'boom' } })

      const result = await run('/cc', '/cc')

      expect(result.status, result.stdout).toBe(1)
      expect(result.errors.some(e => e.includes('could not self cc'))).toBe(true)
      expect(calls()).toEqual([collaboratorRead, `POST ${repo}/pulls/1/requested_reviewers`])
    })

    it('fails the action when the review request for authorized argument users is refused', async () => {
      gh.route('GET', '/orgs/Codertocat/members/octocat', { status: 204 })
      gh.route('GET', `${repo}/collaborators/octocat`, { status: 404, body: { message: 'Not Found' } })
      gh.route('GET', `${repo}/issues/1/comments`, { status: 200, body: [] })
      gh.route('POST', `${repo}/pulls/1/requested_reviewers`, { status: 500, body: { message: 'boom' } })

      const result = await run('/cc @octocat', '/cc')

      expect(result.status, result.stdout).toBe(1)
      expect(result.errors.some(e => e.includes('could not request reviewers'))).toBe(true)
      expect(calls()).toEqual([...membershipReads('octocat'), `GET ${repo}/issues/1/comments`, `POST ${repo}/pulls/1/requested_reviewers`])
      expect(gh.requestsMatching('POST', /requested_reviewers$/)[0].body).toEqual({ reviewers: ['octocat'] })
    })
  })

  describe('/uncc', () => {
    it('fails the action when removing the commenter\'s own review request is refused', async () => {
      gh.route('GET', `${repo}/collaborators/Codertocat`, { status: 204 })
      gh.route('DELETE', `${repo}/pulls/1/requested_reviewers`, { status: 500, body: { message: 'boom' } })

      const result = await run('/uncc', '/uncc')

      expect(result.status, result.stdout).toBe(1)
      expect(result.errors.some(e => e.includes('could not self uncc'))).toBe(true)
      expect(calls()).toEqual([collaboratorRead, `DELETE ${repo}/pulls/1/requested_reviewers`])
    })
  })

  describe('/lock', () => {
    it('fails the action when the lock is refused after the collaborator check passes', async () => {
      gh.route('GET', `${repo}/collaborators/Codertocat`, { status: 204 })
      gh.route('PUT', `${repo}/issues/1/lock`, { status: 500, body: { message: 'boom' } })

      const result = await run('/lock spam', '/lock')

      expect(result.status, result.stdout).toBe(1)
      expect(result.errors.some(e => e.includes('could not lock issue'))).toBe(true)
      expect(calls()).toEqual([collaboratorRead, `PUT ${repo}/issues/1/lock`])
      expect(gh.requestsMatching('PUT', /lock$/)[0].body).toEqual({ lock_reason: 'spam' })
    })
  })

  describe('/unassign', () => {
    it('fails the action when removing the argument users is refused after the commenter is authorized', async () => {
      gh.route('GET', '/orgs/Codertocat/members/Codertocat', { status: 204 })
      gh.route('GET', `${repo}/collaborators/Codertocat`, { status: 404, body: { message: 'Not Found' } })
      gh.route('GET', `${repo}/issues/1/comments`, { status: 200, body: [] })
      gh.route('DELETE', `${repo}/issues/1/assignees`, { status: 500, body: { message: 'boom' } })

      const result = await run('/unassign @octocat', '/unassign')

      expect(result.status, result.stdout).toBe(1)
      expect(result.errors.some(e => e.includes('could not remove assignee'))).toBe(true)
      expect(calls()).toEqual([...membershipReads('Codertocat'), `GET ${repo}/issues/1/comments`, `DELETE ${repo}/issues/1/assignees`])
      expect(gh.requestsMatching('DELETE', /assignees$/)[0].body).toEqual({ assignees: ['octocat'] })
    })
  })
})
