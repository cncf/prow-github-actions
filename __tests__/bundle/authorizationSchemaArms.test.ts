import type { FakeGithub } from './fakeGithub'
import { Buffer } from 'node:buffer'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import labelFileContents from '../fixtures/labels/labelFileContentsResp.json'
import { start } from './fakeGithub'
import { comment, configReads, helpersFor, repo, token } from './helpers'
import { runBundle } from './runBundle'

vi.setConfig({ testTimeout: 30_000 })

const repoSource = 'Codertocat/Hello-World:.github/prow.yaml'
const orgPath = '/repos/Codertocat/.project/contents/prow.yaml'
const repoPath = `${repo}/contents/.github%2Fprow.yaml`

function yamlFile(text: string) {
  const file = structuredClone(labelFileContents)
  file.content = Buffer.from(text).toString('base64')
  return file
}

// the `authorization` section's normalizer (config.ts normalizeAuthorization / normalizeLogins) and the
// cross-tier `users` union (mergeAuthorization), driven through dist/index.js with a `/triage accepted`
describe('dist/index.js authorization section schema', () => {
  let gh: FakeGithub
  const { expectRequests } = helpersFor(() => gh)

  beforeAll(async () => {
    gh = await start()
  })
  afterEach(() => gh.reset())
  afterAll(() => gh.close())

  function triage(login = 'Codertocat') {
    const payload = comment('/triage accepted')
    payload.comment.user.login = login
    gh.route('GET', `${repo}/labels`, { status: 200, body: [{ name: 'triage/accepted' }] })
    gh.route('POST', `${repo}/issues/1/labels`, { status: 200, body: [] })
    return runBundle({
      eventName: 'issue_comment',
      payload,
      inputs: { ...token, 'prow-commands': '/triage' },
      apiUrl: gh.url,
    })
  }

  describe('a malformed section in the repository file', () => {
    it.each([
      ['authorization that is not a mapping', 'authorization: trusted\n', `${repoSource}: authorization must be a mapping`],
      ['an unknown authorization key', 'authorization:\n  approve: anyone\n', `${repoSource}: authorization.approve is not a known key, expected one of labels, hold, close, review, users`],
      ['authorization.labels outside the policy set', 'authorization:\n  labels: owners\n', `${repoSource}: authorization.labels must be one of anyone, collaborators, members, trusted`],
      ['authorization.review outside the review policy set', 'authorization:\n  review: anyone\n', `${repoSource}: authorization.review must be one of members, trusted`],
      ['authorization.users that is not a list', 'authorization:\n  users: friend\n', `${repoSource}: authorization.users must be a list of logins`],
      ['authorization.users with a login that is not a GitHub login', 'authorization:\n  users: ["@friend"]\n', `${repoSource}: authorization.users must be a list of logins`],
    ])('%s fails the command naming the field, with no label write', async (_name, yaml, message) => {
      gh.route('GET', repoPath, { status: 200, body: yamlFile(`labels:\n  triage:\n    values: [accepted]\n${yaml}`) })

      const result = await triage()

      expect(result.status, result.stdout).toBe(1)
      expect(result.errors.some(e => e.includes('could not get labels from yaml: ') && e.includes(message)), result.stdout).toBe(true)
      expect(gh.requestsMatching('POST', /\/issues\/1\/labels$/)).toEqual([])
    })
  })

  describe('users listed by both the organization and the repository tier', () => {
    it('are unioned case-insensitively and admit the login with no membership call', async () => {
      gh.route('GET', orgPath, { status: 200, body: yamlFile('authorization:\n  labels: trusted\n  users: [Friend, Other]\n') })
      gh.route('GET', repoPath, { status: 200, body: yamlFile('labels:\n  triage:\n    values: [accepted]\nauthorization:\n  users: [friend]\n') })

      const result = await triage('friend')

      expect(result.status, result.stdout).toBe(0)
      expect(result.errors).toEqual([])
      expect(gh.requestsMatching('POST', /\/issues\/1\/labels$/)[0].body).toEqual({ labels: ['triage/accepted'] })
      expectRequests(configReads({ org: '.project', repo: '.github/prow.yaml' }), [`GET ${repo}/labels?per_page=100`, `POST ${repo}/issues/1/labels`])
    })
  })
})
