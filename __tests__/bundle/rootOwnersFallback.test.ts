import type { FakeGithub } from './fakeGithub'
import { Buffer } from 'node:buffer'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { start } from './fakeGithub'
import { comment, helpersFor, membershipReads, repo, token } from './helpers'
import { runBundle } from './runBundle'

vi.setConfig({ testTimeout: 30_000 })

// assertAuthorizedByOwnersOrMembership on an issue (not a pull request), driven through dist/index.js: when the
// root OWNERS read 404s the commenter falls back to org membership or collaborator status, and the read's other
// failure arms (a non-404 error, a body with no content) refuse the command by name. Also the 500 arms of the
// membership probes themselves: an org-membership read that fails unexpectedly warns and counts as "not a
// member", and an issue-comments read that fails unexpectedly warns and counts as "has not commented".
describe('dist/index.js OWNERS authorization on an issue without a root OWNERS file', () => {
  const rootOwnersRead = `GET ${repo}/contents/OWNERS`
  const orgRead = '/orgs/Codertocat/members/Codertocat'
  const collaboratorRead = `${repo}/collaborators/Codertocat`
  const commentPost = `POST ${repo}/issues/1/comments`
  const labelPost = `POST ${repo}/issues/1/labels`
  const labelsRead = `GET ${repo}/labels?per_page=100`
  const notFound = { status: 404, body: { message: 'Not Found' } }
  const serverError = { status: 500, body: { message: 'boom' } }
  let gh: FakeGithub
  const { calls, expectCommandThenConfig } = helpersFor(() => gh)

  beforeAll(async () => {
    gh = await start()
  })
  afterEach(() => gh.reset())
  afterAll(() => gh.close())

  function warnings(stdout: string) {
    return stdout.split(/\r?\n/).filter(line => line.startsWith('::warning::')).map(line => line.slice('::warning::'.length))
  }

  function comments() {
    return gh.requestsMatching('POST', /\/issues\/1\/comments$/).map(r => (r.body as { body: string }).body)
  }

  // Codertocat's `/lgtm` on issue #1, which some-author opened, so the commenter is not the author
  async function lgtm() {
    return runBundle({
      eventName: 'issue_comment',
      payload: comment('/lgtm', 'some-author'),
      inputs: { ...token, 'prow-commands': '/lgtm' },
      apiUrl: gh.url,
    })
  }

  describe('/lgtm by a non-author', () => {
    it('is authorized by collaborator status when the root OWNERS read 404s and the org-membership read fails unexpectedly', async () => {
      gh.route('GET', rootOwnersRead.slice('GET '.length), notFound)
      gh.route('GET', orgRead, serverError)
      gh.route('GET', collaboratorRead, { status: 204 })
      gh.route('GET', `${repo}/labels`, { status: 200, body: [{ name: 'lgtm' }] })
      gh.route('POST', labelPost.slice('POST '.length), { status: 200, body: [] })

      const result = await lgtm()

      expect(result.status, result.stdout).toBe(0)
      expect(result.errors).toEqual([])
      expect(warnings(result.stdout)).toEqual(['encountered unexpected error: status=500, message=boom'])
      expect(gh.requestsMatching('POST', /\/issues\/1\/labels$/)[0].body).toEqual({ labels: ['lgtm'] })
      expect(comments()).toEqual([])
      // the root OWNERS read, the membership fallback, the label write, then the post-command sweep's config reads
      expectCommandThenConfig([rootOwnersRead, ...membershipReads('Codertocat'), labelsRead, labelPost])
    })

    it('is refused by name when the root OWNERS read 404s and the commenter is neither an org member nor a collaborator', async () => {
      gh.route('GET', rootOwnersRead.slice('GET '.length), notFound)
      gh.route('GET', orgRead, notFound)
      gh.route('GET', collaboratorRead, notFound)
      gh.route('POST', commentPost.slice('POST '.length), { status: 201, body: {} })

      const result = await lgtm()

      expect(result.status, result.stdout).toBe(1)
      expect(result.errors.some(e => e.includes('Codertocat is not a org member or collaborator'))).toBe(true)
      expect(warnings(result.stdout)).toEqual([])
      expect(comments()).toEqual(['Cannot apply the lgtm label because Error: Codertocat is not a org member or collaborator'])
      expect(gh.requestsMatching('POST', /\/issues\/1\/labels$/)).toEqual([])
      expectCommandThenConfig([rootOwnersRead, ...membershipReads('Codertocat'), commentPost])
    })

    it('is refused without any membership read when the root OWNERS read fails with a non-404 error', async () => {
      gh.route('GET', rootOwnersRead.slice('GET '.length), serverError)
      gh.route('POST', commentPost.slice('POST '.length), { status: 201, body: {} })

      const result = await lgtm()

      expect(result.status, result.stdout).toBe(1)
      expect(result.errors.some(e => e.includes('error checking for an OWNERS file at the root of the repository: HttpError: boom'))).toBe(true)
      expect(comments()).toEqual(['Cannot apply the lgtm label because Error: error checking for an OWNERS file at the root of the repository: HttpError: boom'])
      expect(gh.requestsMatching('GET', /\/orgs\/|\/collaborators\//)).toEqual([])
      expectCommandThenConfig([rootOwnersRead, commentPost])
    })

    it('is refused without any membership read when the root OWNERS path is a directory, which the contents API lists without content', async () => {
      gh.route('GET', rootOwnersRead.slice('GET '.length), {
        status: 200,
        body: [{ name: 'alice', path: 'OWNERS/alice', type: 'file', content: Buffer.from('x').toString('base64') }],
      })
      gh.route('POST', commentPost.slice('POST '.length), { status: 201, body: {} })

      const result = await lgtm()

      expect(result.status, result.stdout).toBe(1)
      expect(result.errors.some(e => e.includes('invalid OWNERS file returned from GitHub API'))).toBe(true)
      expect(comments()).toHaveLength(1)
      expect(comments()[0]).toContain('Cannot apply the lgtm label because Error: invalid OWNERS file returned from GitHub API')
      expect(gh.requestsMatching('GET', /\/orgs\/|\/collaborators\//)).toEqual([])
      expectCommandThenConfig([rootOwnersRead, commentPost])
    })
  })

  describe('/unassign by a non-author', () => {
    it('warns and removes nothing when the commenter is not a member or collaborator and the issue-comments read fails unexpectedly', async () => {
      gh.route('GET', orgRead, notFound)
      gh.route('GET', collaboratorRead, notFound)
      gh.route('GET', `${repo}/issues/1/comments`, serverError)

      const result = await runBundle({
        eventName: 'issue_comment',
        payload: comment('/unassign @octocat', 'some-author'),
        inputs: { ...token, 'prow-commands': '/unassign' },
        apiUrl: gh.url,
      })

      expect(result.status, result.stdout).toBe(0)
      expect(result.errors).toEqual([])
      expect(warnings(result.stdout)).toEqual(['encountered unexpected error checking issue comments: status=500, message=boom'])
      expect(gh.requestsMatching('DELETE', /\/issues\/1\/assignees$/)).toEqual([])
      expect(calls()).toEqual([...membershipReads('Codertocat'), `GET ${repo}/issues/1/comments`])
    })
  })
})
