import type { FakeGithub } from './fakeGithub'
import { Buffer } from 'node:buffer'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import pullReqOpenedEvent from '../fixtures/pullReq/pullReqOpenedEvent.json'
import { prCommentEvent } from '../utils/ownersFixtures'
import { start } from './fakeGithub'
import { comment, configReads, helpersFor, membershipReads, repo, token } from './helpers'
import { runBundle } from './runBundle'

vi.setConfig({ testTimeout: 30_000 })

// the opt-in authorization section, driven through dist/index.js: a `users` login who is neither an org member
// nor a collaborator keeps triaging and reviewing on a repository without OWNERS files
describe('dist/index.js authorization', () => {
  const labelsRead = `GET ${repo}/labels?per_page=100`
  const labelPost = `POST ${repo}/issues/1/labels`
  const prowYamlPath = `${repo}/contents/${encodeURIComponent('.github/prow.yaml')}`
  const prowYaml = `GET ${prowYamlPath}`
  let gh: FakeGithub
  const { calls, expectRequests, routeOwners } = helpersFor(() => gh)

  beforeAll(async () => {
    gh = await start()
  })
  beforeEach(() => gh.mergeQueueFallback({ pullRequestId: 'PR_none', headOid: pullReqOpenedEvent.pull_request.head.sha, enabled: false }))
  afterEach(() => gh.reset())
  afterAll(() => gh.close())

  function routeConfig(text: string) {
    gh.route('GET', prowYamlPath, { status: 200, body: { type: 'file', encoding: 'base64', content: Buffer.from(text).toString('base64') } })
  }

  function byCommenter<T extends { comment: { user: { login: string } } }>(payload: T, login: string): T {
    payload.comment.user.login = login
    return payload
  }

  describe('/triage under labels: trusted', () => {
    const config = 'labels:\n  triage:\n    values: [accepted]\nauthorization:\n  labels: trusted\n  users: [Friend]\n'

    async function triage(login: string) {
      return runBundle({
        eventName: 'issue_comment',
        payload: byCommenter(comment('/triage accepted'), login),
        inputs: { ...token, 'prow-commands': '/triage' },
        apiUrl: gh.url,
      })
    }

    it('by a users login applies the label with no membership call', async () => {
      routeConfig(config)
      gh.route('GET', `${repo}/labels`, { status: 200, body: [{ name: 'triage/accepted' }] })
      gh.route('POST', `${repo}/issues/1/labels`, { status: 200, body: [] })

      const result = await triage('friend')

      expect(result.status, result.stdout).toBe(0)
      expect(result.errors).toEqual([])
      expect(gh.requestsMatching('POST', /\/issues\/1\/labels$/)[0].body).toEqual({ labels: ['triage/accepted'] })
      expectRequests(configReads({ repo: '.github/prow.yaml' }), [labelsRead, labelPost])
    })

    it('by an outsider fails the run and writes no label', async () => {
      routeConfig(config)
      gh.route('GET', '/orgs/Codertocat/members/outsider', { status: 404, body: { message: 'Not Found' } })
      gh.route('GET', `${repo}/collaborators/outsider`, { status: 404, body: { message: 'Not Found' } })

      const result = await triage('outsider')

      expect(result.status, result.stdout).toBe(1)
      expect(result.errors.some(e => e.includes('outsider is not authorized to run /triage: authorization.labels is trusted'))).toBe(true)
      expect(gh.requestsMatching('POST', /./)).toEqual([])
      expectRequests(configReads({ repo: '.github/prow.yaml' }), [...membershipReads('outsider'), `GET ${repo}/contents/OWNERS`])
    })
  })

  describe('/lgtm under review: trusted on a repository without OWNERS files', () => {
    it('by a users login who is neither member nor collaborator binds the head and labels', async () => {
      routeConfig('authorization:\n  review: trusted\n  users: [friend]\n')
      routeOwners({}, ['src/file1.txt'], { user: { login: 'some-author' } })
      gh.route('GET', '/orgs/Codertocat/members/friend', { status: 404, body: { message: 'Not Found' } })
      gh.route('GET', `${repo}/collaborators/friend`, { status: 404, body: { message: 'Not Found' } })
      gh.route('POST', `${repo}/statuses/headsha`, { status: 201, body: {} })
      gh.route('GET', `${repo}/labels`, { status: 200, body: [{ name: 'lgtm' }] })
      gh.route('POST', `${repo}/issues/1/labels`, { status: 200, body: [] })

      const result = await runBundle({
        eventName: 'issue_comment',
        payload: prCommentEvent('/lgtm', 'friend'),
        inputs: { ...token, 'prow-commands': '/lgtm' },
        apiUrl: gh.url,
      })

      expect(result.status, result.stdout).toBe(0)
      expect(result.errors).toEqual([])
      expect(gh.requestsMatching('POST', /\/statuses\/headsha$/)[0].body).toMatchObject({ state: 'success', context: 'prow/lgtm' })
      expect(gh.requestsMatching('POST', /\/issues\/1\/labels$/)[0].body).toEqual({ labels: ['lgtm'] })
      // membership is checked first; the configuration is read only once both refuse
      const recorded = calls()
      expect(recorded.indexOf(prowYaml)).toBeGreaterThan(recorded.indexOf(`GET ${repo}/collaborators/friend`))
      expect(recorded.indexOf(prowYaml)).toBeGreaterThan(recorded.indexOf('GET /orgs/Codertocat/members/friend'))
    })
  })
})
