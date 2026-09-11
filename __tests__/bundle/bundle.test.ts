import type { FakeGithub } from './fakeGithub'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import process from 'node:process'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import issueCommentEvent from '../fixtures/issues/issueCommentEvent.json'
import labelFileContents from '../fixtures/labels/labelFileContentsResp.json'
import pullReqListPulls from '../fixtures/pullReq/pullReqListPulls.json'
import pullReqOpenedEvent from '../fixtures/pullReq/pullReqOpenedEvent.json'
import { start } from './fakeGithub'
import { bundlePath, runBundle } from './runBundle'

vi.setConfig({ testTimeout: 30_000 })

const repo = '/repos/Codertocat/Hello-World'
const token = { 'github-token': 'some-token' }

function comment(body: string, author = issueCommentEvent.issue.user.login) {
  const payload = structuredClone(issueCommentEvent)
  payload.comment.body = body
  payload.issue.user.login = author
  return payload
}

function openPr(labels: string[], overrides: Record<string, unknown> = {}) {
  const pr = structuredClone(pullReqListPulls[0])
  return { ...pr, labels: labels.map(name => ({ name })), ...overrides }
}

describe('dist/index.js', () => {
  let gh: FakeGithub

  beforeAll(async () => {
    gh = await start()
  })
  afterEach(() => gh.reset())
  afterAll(() => gh.close())

  it('is a syntactically valid bundle with no unresolved modules', () => {
    expect(fs.existsSync(bundlePath)).toBe(true)

    const check = spawnSync(process.execPath, ['--check', bundlePath], { encoding: 'utf8' })
    expect(check.status, check.stderr).toBe(0)

    expect(fs.readFileSync(bundlePath, 'utf8')).not.toContain('webpackMissingModule')
  })

  it('logs an error for an unsupported event without failing or calling the api', async () => {
    const result = await runBundle({ eventName: 'push', payload: {}, inputs: token, apiUrl: gh.url })

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('push not yet supported')
    expect(result.errors).toEqual(['push not yet supported'])
    expect(gh.requests).toEqual([])
  })

  it('issue_comment /kind adds a prefixed label from .prowlabels.yaml', async () => {
    gh.route('GET', `${repo}/contents/.prowlabels.yaml`, { status: 200, body: labelFileContents })
    gh.route('POST', `${repo}/issues/1/labels`, { status: 200, body: [] })

    const result = await runBundle({
      eventName: 'issue_comment',
      payload: comment('/kind cleanup'),
      inputs: { ...token, 'prow-commands': '/kind' },
      apiUrl: gh.url,
    })

    expect(result.status, result.stdout).toBe(0)
    expect(result.errors).toEqual([])
    const posts = gh.requestsMatching('POST', /\/issues\/1\/labels$/)
    expect(posts).toHaveLength(1)
    expect(posts[0].body).toEqual({ labels: ['kind/cleanup'] })
    expect(gh.requests.map(r => `${r.method} ${r.path}`)).toEqual([
      `GET ${repo}/contents/.prowlabels.yaml`,
      `POST ${repo}/issues/1/labels`,
    ])
  })

  it('issue_comment /remove-kind removes a prefixed label when /kind is configured', async () => {
    gh.route('GET', `${repo}/contents/.prowlabels.yaml`, { status: 200, body: labelFileContents })
    gh.route('GET', `${repo}/issues/1`, { status: 200, body: { labels: [{ name: 'kind/cleanup' }] } })
    gh.route('DELETE', `${repo}/issues/1/labels/kind%2Fcleanup`, { status: 200, body: [] })

    const result = await runBundle({
      eventName: 'issue_comment',
      payload: comment('/remove-kind cleanup'),
      inputs: { ...token, 'prow-commands': '/kind' },
      apiUrl: gh.url,
    })

    expect(result.status, result.stdout).toBe(0)
    expect(result.errors).toEqual([])
    expect(gh.requestsMatching('POST', /./)).toEqual([])
    expect(gh.requests.map(r => `${r.method} ${r.path}`)).toEqual([
      `GET ${repo}/contents/.prowlabels.yaml`,
      `GET ${repo}/issues/1`,
      `DELETE ${repo}/issues/1/labels/kind%2Fcleanup`,
    ])
  })

  it('issue_comment /label adds an allowlisted label verbatim', async () => {
    gh.route('GET', `${repo}/contents/.prowlabels.yaml`, { status: 200, body: labelFileContents })
    gh.route('POST', `${repo}/issues/1/labels`, { status: 200, body: [] })

    const result = await runBundle({
      eventName: 'issue_comment',
      payload: comment('/label good-first-issue'),
      inputs: { ...token, 'prow-commands': '/label' },
      apiUrl: gh.url,
    })

    expect(result.status, result.stdout).toBe(0)
    expect(result.errors).toEqual([])
    const posts = gh.requestsMatching('POST', /\/issues\/1\/labels$/)
    expect(posts).toHaveLength(1)
    expect(posts[0].body).toEqual({ labels: ['good-first-issue'] })
    expect(gh.requests.map(r => `${r.method} ${r.path}`)).toEqual([
      `GET ${repo}/contents/.prowlabels.yaml`,
      `POST ${repo}/issues/1/labels`,
    ])
  })

  it('issue_comment /assign self-assigns an org member', async () => {
    gh.route('GET', '/orgs/Codertocat/members/Codertocat', { status: 204 })
    gh.route('GET', `${repo}/collaborators/Codertocat`, { status: 404, body: { message: 'Not Found' } })
    gh.route('GET', `${repo}/issues/1/comments`, { status: 200, body: [] })
    gh.route('POST', `${repo}/issues/1/assignees`, { status: 201, body: {} })

    const result = await runBundle({
      eventName: 'issue_comment',
      payload: comment('/assign'),
      inputs: { ...token, 'prow-commands': '/assign' },
      apiUrl: gh.url,
    })

    expect(result.status, result.stdout).toBe(0)
    expect(result.errors).toEqual([])
    expect(gh.requests.map(r => `${r.method} ${r.path}`)).toEqual([
      'GET /orgs/Codertocat/members/Codertocat',
      `GET ${repo}/collaborators/Codertocat`,
      `GET ${repo}/issues/1/comments`,
      `POST ${repo}/issues/1/assignees`,
    ])
    expect(gh.requestsMatching('POST', /assignees$/)[0].body).toEqual({ assignees: ['Codertocat'] })
  })

  it('issue_comment /close by a non-collaborator non-author is a silent no-op', async () => {
    gh.route('GET', `${repo}/collaborators/Codertocat`, { status: 404, body: { message: 'Not Found' } })

    const result = await runBundle({
      eventName: 'issue_comment',
      payload: comment('/close', 'some-author'),
      inputs: { ...token, 'prow-commands': '/close' },
      apiUrl: gh.url,
    })

    expect(result.status, result.stdout).toBe(0)
    expect(result.errors).toEqual([])
    expect(gh.requestsMatching('PATCH', /./)).toEqual([])
    expect(gh.requests.map(r => `${r.method} ${r.path}`)).toEqual([
      `GET ${repo}/collaborators/Codertocat`,
    ])
  })

  it('issue_comment /close not-planned by a collaborator closes with state_reason not_planned', async () => {
    gh.route('GET', `${repo}/collaborators/Codertocat`, { status: 204 })
    gh.route('PATCH', `${repo}/issues/1`, { status: 200, body: {} })

    const result = await runBundle({
      eventName: 'issue_comment',
      payload: comment('/close not-planned', 'some-author'),
      inputs: { ...token, 'prow-commands': '/close' },
      apiUrl: gh.url,
    })

    expect(result.status, result.stdout).toBe(0)
    expect(result.errors).toEqual([])
    const patches = gh.requestsMatching('PATCH', /\/issues\/1$/)
    expect(patches).toHaveLength(1)
    expect(patches[0].body).toEqual({ state: 'closed', state_reason: 'not_planned' })
    expect(gh.requests.map(r => `${r.method} ${r.path}`)).toEqual([
      `GET ${repo}/collaborators/Codertocat`,
      `PATCH ${repo}/issues/1`,
    ])
  })

  it('issue_comment /lgtm by the pr author is refused with a comment and fails the action', async () => {
    gh.route('GET', `${repo}/contents/OWNERS`, { status: 404, body: { message: 'Not Found' } })
    gh.route('GET', '/orgs/Codertocat/members/Codertocat', { status: 204 })
    gh.route('GET', `${repo}/collaborators/Codertocat`, { status: 204 })
    gh.route('POST', `${repo}/issues/1/comments`, { status: 201, body: {} })
    gh.route('POST', `${repo}/issues/1/labels`, { status: 200, body: [] })

    const result = await runBundle({
      eventName: 'issue_comment',
      payload: comment('/lgtm'),
      inputs: { ...token, 'prow-commands': '/lgtm' },
      apiUrl: gh.url,
    })

    expect(result.status, result.stdout).toBe(1)
    expect(result.errors.some(e => e.includes('you cannot LGTM your own PR.'))).toBe(true)
    expect(gh.requestsMatching('POST', /\/issues\/1\/labels$/)).toEqual([])
    const comments = gh.requestsMatching('POST', /\/issues\/1\/comments$/)
    expect(comments).toHaveLength(1)
    expect(comments[0].body).toEqual({ body: 'you cannot LGTM your own PR.' })
  })

  it('issue_comment /remove fails the action when the api returns 500', async () => {
    gh.route('GET', `${repo}/collaborators/Codertocat`, { status: 204 })
    gh.route('GET', `${repo}/issues/1`, { status: 200, body: { labels: [{ name: 'foo' }] } })
    gh.route('DELETE', `${repo}/issues/1/labels/foo`, { status: 500, body: { message: 'boom' } })

    const result = await runBundle({
      eventName: 'issue_comment',
      payload: comment('/remove foo'),
      inputs: { ...token, 'prow-commands': '/remove' },
      apiUrl: gh.url,
    })

    expect(result.status, result.stdout).toBe(1)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toMatch(/could not remove label foo/)
    expect(gh.requests.map(r => `${r.method} ${r.path}`)).toEqual([
      `GET ${repo}/collaborators/Codertocat`,
      `GET ${repo}/issues/1`,
      `DELETE ${repo}/issues/1/labels/foo`,
    ])
  })

  it('issue_comment /milestone clear unsets the milestone for a collaborator', async () => {
    gh.route('GET', `${repo}/collaborators/Codertocat`, { status: 204 })
    gh.route('PATCH', `${repo}/issues/1`, { status: 200, body: {} })

    const result = await runBundle({
      eventName: 'issue_comment',
      payload: comment('/milestone clear'),
      inputs: { ...token, 'prow-commands': '/milestone' },
      apiUrl: gh.url,
    })

    expect(result.status, result.stdout).toBe(0)
    expect(result.errors).toEqual([])
    const patches = gh.requestsMatching('PATCH', /\/issues\/1$/)
    expect(patches).toHaveLength(1)
    expect(patches[0].body).toEqual({ milestone: null })
    expect(gh.requests.map(r => `${r.method} ${r.path}`)).toEqual([
      `GET ${repo}/collaborators/Codertocat`,
      `PATCH ${repo}/issues/1`,
    ])
  })

  it('issue_comment /unhold removes the hold label when /hold is configured', async () => {
    gh.route('GET', `${repo}/issues/1`, { status: 200, body: { labels: [{ name: 'hold' }] } })
    gh.route('DELETE', `${repo}/issues/1/labels/hold`, { status: 200, body: [] })

    const result = await runBundle({
      eventName: 'issue_comment',
      payload: comment('/unhold'),
      inputs: { ...token, 'prow-commands': '/hold' },
      apiUrl: gh.url,
    })

    expect(result.status, result.stdout).toBe(0)
    expect(result.errors).toEqual([])
    expect(gh.requests.map(r => `${r.method} ${r.path}`)).toEqual([
      `GET ${repo}/issues/1`,
      `DELETE ${repo}/issues/1/labels/hold`,
    ])
  })

  it('pull_request lgtm job removes the lgtm label on a new push', async () => {
    gh.route('GET', `${repo}/issues/1`, { status: 200, body: { labels: [{ name: 'lgtm' }] } })
    gh.route('DELETE', `${repo}/issues/1/labels/lgtm`, { status: 200, body: [] })

    const result = await runBundle({
      eventName: 'pull_request',
      payload: pullReqOpenedEvent,
      inputs: { ...token, jobs: 'lgtm' },
      apiUrl: gh.url,
    })

    expect(result.status, result.stdout).toBe(0)
    expect(result.errors).toEqual([])
    expect(gh.requests.map(r => `${r.method} ${r.path}`)).toEqual([
      `GET ${repo}/issues/1`,
      `DELETE ${repo}/issues/1/labels/lgtm`,
    ])
  })

  describe('schedule lgtm job', () => {
    function routePulls(pr: unknown) {
      gh.route('GET', new RegExp(`^${repo}/pulls\\?`), (req) => {
        const page = new URL(req.path, gh.url).searchParams.get('page')
        return { status: 200, body: page === '1' ? [pr] : [] }
      })
      gh.route('PUT', `${repo}/pulls/2/merge`, { status: 200, body: { merged: true } })
    }

    function runCron() {
      return runBundle({
        eventName: 'schedule',
        payload: {},
        inputs: { ...token, 'jobs': 'lgtm', 'merge-method': 'squash' },
        apiUrl: gh.url,
      })
    }

    it('squash-merges an open lgtm pr', async () => {
      routePulls(openPr(['lgtm']))

      const result = await runCron()

      expect(result.status, result.stdout).toBe(0)
      expect(result.errors).toEqual([])
      const merges = gh.requestsMatching('PUT', /\/pulls\/2\/merge$/)
      expect(merges).toHaveLength(1)
      expect(merges[0].body).toEqual({ merge_method: 'squash' })
      expect(gh.requests.map(r => `${r.method} ${r.path}`)).toEqual([
        `GET ${repo}/pulls?state=open&page=1`,
        `PUT ${repo}/pulls/2/merge`,
        `GET ${repo}/pulls?state=open&page=2`,
      ])
    })

    it('does not merge a pr that also has the hold label', async () => {
      routePulls(openPr(['lgtm', 'hold']))

      const result = await runCron()

      expect(result.status, result.stdout).toBe(0)
      expect(result.errors).toEqual([])
      expect(gh.requestsMatching('PUT', /./)).toEqual([])
      expect(gh.requests.map(r => `${r.method} ${r.path}`)).toEqual([
        `GET ${repo}/pulls?state=open&page=1`,
        `GET ${repo}/pulls?state=open&page=2`,
      ])
    })

    it('does not merge a locked pr', async () => {
      routePulls(openPr(['lgtm'], { locked: true }))

      const result = await runCron()

      expect(result.status, result.stdout).toBe(0)
      expect(result.errors).toEqual([])
      expect(gh.requestsMatching('PUT', /./)).toEqual([])
      expect(gh.requests.map(r => `${r.method} ${r.path}`)).toEqual([
        `GET ${repo}/pulls?state=open&page=1`,
        `GET ${repo}/pulls?state=open&page=2`,
      ])
    })
  })
})
