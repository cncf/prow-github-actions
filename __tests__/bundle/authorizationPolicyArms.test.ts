import type { FakeGithub } from './fakeGithub'
import { Buffer } from 'node:buffer'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import pullReqOpenedEvent from '../fixtures/pullReq/pullReqOpenedEvent.json'
import { prCommentEvent } from '../utils/ownersFixtures'
import { start } from './fakeGithub'
import { comment, configReads, helpersFor, membershipReads, ownersReads, repo, token } from './helpers'
import { runBundle } from './runBundle'

vi.setConfig({ testTimeout: 30_000 })

// the `authorization` policy arms (src/utils/auth.ts: policyAllows, closePolicyAllows, loadAuthorization,
// rootOwnersIncludes and the review fallback of assertAuthorizedByOwnersOrMembership) that
// authorization.test.ts leaves out, driven through dist/index.js against the fake api
describe('dist/index.js authorization policy arms', () => {
  const labelsRead = `GET ${repo}/labels?per_page=100`
  const labelPost = `POST ${repo}/issues/1/labels`
  const rootOwnersRead = `GET ${repo}/contents/OWNERS`
  const prowYamlPath = `${repo}/contents/${encodeURIComponent('.github/prow.yaml')}`
  const notFound = { status: 404, body: { message: 'Not Found' } }
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

  function warnings(stdout: string) {
    return stdout.split('\n').filter(line => line.startsWith('::warning::'))
  }

  describe('/triage accepted', () => {
    const triageConfig = (policy: string) => `labels:\n  triage:\n    values: [accepted]\nauthorization:\n  labels: ${policy}\n`

    async function triage(login: string) {
      const payload = comment('/triage accepted')
      payload.comment.user.login = login
      return runBundle({ eventName: 'issue_comment', payload, inputs: { ...token, 'prow-commands': '/triage' }, apiUrl: gh.url })
    }

    function routeLabelWrite() {
      gh.route('GET', `${repo}/labels`, { status: 200, body: [{ name: 'triage/accepted' }] })
      gh.route('POST', `${repo}/issues/1/labels`, { status: 200, body: [] })
    }

    it('under labels: members, by an org member: admitted by the membership read alone', async () => {
      routeConfig(triageConfig('members'))
      gh.route('GET', '/orgs/Codertocat/members/member', { status: 204 })
      routeLabelWrite()

      const result = await triage('member')

      expect(result.status, result.stdout).toBe(0)
      expect(result.errors).toEqual([])
      expect(gh.requestsMatching('POST', /\/issues\/1\/labels$/)[0].body).toEqual({ labels: ['triage/accepted'] })
      expect(gh.requestsMatching('GET', /\/collaborators\//)).toEqual([])
      expectRequests(configReads({ repo: '.github/prow.yaml' }), ['GET /orgs/Codertocat/members/member', labelsRead, labelPost])
    })

    it('under labels: collaborators, by a collaborator: admitted without any membership read', async () => {
      routeConfig(triageConfig('collaborators'))
      gh.route('GET', `${repo}/collaborators/collab`, { status: 204 })
      routeLabelWrite()

      const result = await triage('collab')

      expect(result.status, result.stdout).toBe(0)
      expect(result.errors).toEqual([])
      expect(gh.requestsMatching('POST', /\/issues\/1\/labels$/)[0].body).toEqual({ labels: ['triage/accepted'] })
      expect(gh.requestsMatching('GET', /\/orgs\//)).toEqual([])
      expectRequests(configReads({ repo: '.github/prow.yaml' }), [`GET ${repo}/collaborators/collab`, labelsRead, labelPost])
    })

    it('under labels: trusted, by a root OWNERS reviewer who is neither member, collaborator nor listed: admitted by the OWNERS file', async () => {
      routeConfig(triageConfig('trusted'))
      gh.route('GET', '/orgs/Codertocat/members/rita', notFound)
      gh.route('GET', `${repo}/collaborators/rita`, notFound)
      gh.route('GET', `${repo}/contents/OWNERS`, {
        status: 200,
        body: { type: 'file', encoding: 'base64', content: Buffer.from('reviewers:\n- Rita\napprovers:\n- alice\n').toString('base64') },
      })
      routeLabelWrite()

      const result = await triage('rita')

      expect(result.status, result.stdout).toBe(0)
      expect(result.errors).toEqual([])
      expect(gh.requestsMatching('POST', /\/issues\/1\/labels$/)[0].body).toEqual({ labels: ['triage/accepted'] })
      expectRequests(configReads({ repo: '.github/prow.yaml' }), [...membershipReads('rita'), rootOwnersRead, labelsRead, labelPost])
    })

    it('under labels: collaborators, with no commenter login in the payload: refused before any read', async () => {
      routeConfig(triageConfig('collaborators'))
      const payload = comment('/triage accepted') as Record<string, any>
      delete payload.comment.user.login

      const result = await runBundle({ eventName: 'issue_comment', payload, inputs: { ...token, 'prow-commands': '/triage' }, apiUrl: gh.url })

      expect(result.status, result.stdout).toBe(1)
      expect(result.errors.some(e => e.includes('is not authorized to run /triage: authorization.labels is collaborators'))).toBe(true)
      expect(gh.requestsMatching('POST', /./)).toEqual([])
      expectRequests(configReads({ repo: '.github/prow.yaml' }), [])
    })
  })

  describe('/close by a stranger', () => {
    it('when the authorization section does not parse: refused silently with a warning, nothing is closed', async () => {
      routeConfig('authorization:\n  close: everyone\n')
      gh.route('GET', `${repo}/collaborators/stranger`, notFound)
      const payload = comment('/close')
      payload.comment.user.login = 'stranger'

      const result = await runBundle({ eventName: 'issue_comment', payload, inputs: { ...token, 'prow-commands': '/close' }, apiUrl: gh.url })

      expect(result.status, result.stdout).toBe(0)
      expect(result.errors).toEqual([])
      expect(warnings(result.stdout).some(w => w.includes('authorization: could not load prow config'))).toBe(true)
      expect(warnings(result.stdout).some(w => w.includes('authorization.close'))).toBe(true)
      expect(gh.requestsMatching('PATCH', /./)).toEqual([])
      expect(gh.requestsMatching('GET', /\/orgs\//)).toEqual([])
      expectRequests([`GET ${repo}/collaborators/stranger`, ...configReads({ repo: '.github/prow.yaml' })], [])
    })
  })

  describe('/lgtm on a pull request without OWNERS files', () => {
    async function lgtm(login: string) {
      return runBundle({ eventName: 'issue_comment', payload: prCommentEvent('/lgtm', login), inputs: { ...token, 'prow-commands': '/lgtm' }, apiUrl: gh.url })
    }

    function routeStranger(login: string) {
      routeOwners({}, ['src/file1.txt'], { user: { login: 'some-author' } })
      gh.route('GET', `/orgs/Codertocat/members/${login}`, notFound)
      gh.route('GET', `${repo}/collaborators/${login}`, notFound)
      gh.route('POST', `${repo}/issues/1/comments`, { status: 201, body: {} })
    }

    it('under review: trusted, by a user who is neither member, collaborator nor listed: refused naming authorization.users', async () => {
      routeConfig('authorization:\n  review: trusted\n  users: [friend]\n')
      routeStranger('outsider')

      const result = await lgtm('outsider')

      expect(result.status, result.stdout).toBe(1)
      expect(result.errors.some(e => e.includes('outsider is not a org member, collaborator or listed in authorization.users'))).toBe(true)
      expect(gh.requestsMatching('POST', /\/statuses\//)).toEqual([])
      expect(gh.requestsMatching('POST', /\/issues\/1\/labels$/)).toEqual([])
      expect(gh.requestsMatching('POST', /\/issues\/1\/comments$/)).toHaveLength(1)
      // the owners reads and the membership reads refuse first; only then is the configuration read
      const recorded = calls()
      expect(recorded.slice(0, ownersReads.length + 2).sort()).toEqual([...ownersReads, ...membershipReads('outsider')].sort())
      expect(recorded.indexOf(`GET ${prowYamlPath}`)).toBeGreaterThan(recorded.indexOf(`GET ${repo}/collaborators/outsider`))
    })

    it('when the authorization section does not parse: warns and falls back to the members default', async () => {
      routeConfig('authorization:\n  review: anyone\n')
      routeStranger('outsider')

      const result = await lgtm('outsider')

      expect(result.status, result.stdout).toBe(1)
      expect(result.errors.some(e => e.includes('outsider is not a org member or collaborator'))).toBe(true)
      expect(warnings(result.stdout).some(w => w.includes('authorization: could not load prow config'))).toBe(true)
      expect(warnings(result.stdout).some(w => w.includes('authorization.review'))).toBe(true)
      expect(gh.requestsMatching('POST', /\/statuses\//)).toEqual([])
      expect(gh.requestsMatching('POST', /\/issues\/1\/labels$/)).toEqual([])
    })
  })
})
