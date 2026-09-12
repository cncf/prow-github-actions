import type { FakeGithub } from './fakeGithub'
import { Buffer } from 'node:buffer'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import process from 'node:process'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import issueCommentEvent from '../fixtures/issues/issueCommentEvent.json'
import labelFileContents from '../fixtures/labels/labelFileContentsResp.json'
import pullReqListPulls from '../fixtures/pullReq/pullReqListPulls.json'
import pullReqOpenedEvent from '../fixtures/pullReq/pullReqOpenedEvent.json'
import { blobSha, prCommentEvent } from '../utils/ownersFixtures'
import { start } from './fakeGithub'
import { bundlePath, runBundle } from './runBundle'

vi.setConfig({ testTimeout: 30_000 })

const repo = '/repos/Codertocat/Hello-World'
const token = { 'github-token': 'some-token' }
// the read every label command makes before it applies a label
const labelsRead = `GET ${repo}/labels?per_page=100`

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

function repoLabels(...names: string[]) {
  return { status: 200, body: names.map(name => ({ name })) }
}

function yamlFile(text: string) {
  const file = structuredClone(labelFileContents)
  file.content = Buffer.from(text).toString('base64')
  return file
}

const orgConfigRepos = ['.project', '.github']
const repoConfigFiles = [
  '.github/prow.yaml',
  '.github/prowlabels.yaml',
  'prow.yaml',
  '.prowlabels.yaml',
  '.github/prow.yml',
  '.github/prowlabels.yml',
  'prow.yml',
  '.prowlabels.yml',
]

// the configuration reads the loader makes before it finds `org` and `repo` (or gives up on a tier)
function configReads({ org, repo: file }: { org?: string, repo?: string } = {}): string[] {
  const orgReads = orgConfigRepos
    .slice(0, org ? orgConfigRepos.indexOf(org) + 1 : orgConfigRepos.length)
    .map(name => `GET /repos/Codertocat/${name}/contents/prow.yaml`)
  const repoReads = repoConfigFiles
    .slice(0, file ? repoConfigFiles.indexOf(file) + 1 : repoConfigFiles.length)
    .map(path => `GET ${repo}/contents/${encodeURIComponent(path)}`)
  return [...orgReads, ...repoReads]
}

describe('dist/index.js', () => {
  let gh: FakeGithub

  beforeAll(async () => {
    gh = await start()
  })
  afterEach(() => gh.reset())
  afterAll(() => gh.close())

  // the org and repo tiers are probed concurrently, so the reads have no fixed order among themselves
  function expectRequests(reads: string[], rest: string[]) {
    const calls = gh.requests.map(r => `${r.method} ${r.path}`)
    expect(calls.slice(0, reads.length).sort()).toEqual([...reads].sort())
    expect(calls.slice(reads.length)).toEqual(rest)
  }

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
    gh.route('GET', `${repo}/labels`, repoLabels('kind/cleanup'))
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
    expectRequests([...configReads({ repo: '.prowlabels.yaml' }), labelsRead], [`POST ${repo}/issues/1/labels`])
  })

  it('issue_comment /kind refuses a label the repository does not have without posting', async () => {
    gh.route('GET', `${repo}/contents/.prowlabels.yaml`, { status: 200, body: labelFileContents })
    gh.route('GET', `${repo}/labels`, repoLabels('kind/failing-test'))
    gh.route('POST', `${repo}/issues/1/labels`, { status: 200, body: [] })

    const result = await runBundle({
      eventName: 'issue_comment',
      payload: comment('/kind cleanup'),
      inputs: { ...token, 'prow-commands': '/kind' },
      apiUrl: gh.url,
    })

    expect(result.status, result.stdout).toBe(1)
    expect(result.errors.some(e => e.includes(`the label(s) kind/cleanup cannot be applied because the repository doesn't have them`))).toBe(true)
    expect(gh.requestsMatching('POST', /./)).toEqual([])
    expectRequests([...configReads({ repo: '.prowlabels.yaml' }), labelsRead], [])
  })

  it('issue_comment /kind reads labels from the organization .project repo when the repo has no configuration', async () => {
    gh.route('GET', '/repos/Codertocat/.project/contents/prow.yaml', { status: 200, body: yamlFile('labels:\n  kind: [cleanup]\n') })
    gh.route('GET', `${repo}/labels`, repoLabels('kind/cleanup'))
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
    expectRequests([...configReads({ org: '.project' }), labelsRead], [`POST ${repo}/issues/1/labels`])
  })

  it('issue_comment ignores a /kind inside a fenced code block without calling the api', async () => {
    const result = await runBundle({
      eventName: 'issue_comment',
      payload: comment('try:\n```\n/kind cleanup\n```'),
      inputs: { ...token, 'prow-commands': '/kind' },
      apiUrl: gh.url,
    })

    expect(result.status, result.stdout).toBe(0)
    expect(result.errors).toEqual([])
    expect(gh.requests).toEqual([])
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
    expectRequests(configReads({ repo: '.prowlabels.yaml' }), [
      `GET ${repo}/issues/1`,
      `DELETE ${repo}/issues/1/labels/kind%2Fcleanup`,
    ])
  })

  it('issue_comment /label adds an allowlisted label verbatim', async () => {
    gh.route('GET', `${repo}/contents/.prowlabels.yaml`, { status: 200, body: labelFileContents })
    gh.route('GET', `${repo}/labels`, repoLabels('good-first-issue'))
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
    expectRequests([...configReads({ repo: '.prowlabels.yaml' }), labelsRead], [`POST ${repo}/issues/1/labels`])
  })

  it('issue_comment /remove-label refuses lgtm even when .prowlabels.yaml lists it', async () => {
    gh.route('GET', `${repo}/contents/.prowlabels.yaml`, { status: 200, body: yamlFile('labels:\n  - lgtm\n  - documentation\n') })
    gh.route('GET', `${repo}/issues/1`, { status: 200, body: { labels: [{ name: 'lgtm' }] } })
    gh.route('DELETE', `${repo}/issues/1/labels/lgtm`, { status: 200, body: [] })

    const result = await runBundle({
      eventName: 'issue_comment',
      payload: comment('/remove-label lgtm'),
      inputs: { ...token, 'prow-commands': '/label' },
      apiUrl: gh.url,
    })

    expect(result.status, result.stdout).toBe(1)
    expect(result.errors.some(e => e.includes('managed by its own command'))).toBe(true)
    expect(gh.requestsMatching('DELETE', /./)).toEqual([])
    expectRequests(configReads({ repo: '.prowlabels.yaml' }), [])
  })

  it('issue_comment /level uses a mapping-form yaml key as an exclusive label command', async () => {
    gh.route('GET', `${repo}/contents/.prowlabels.yaml`, { status: 200, body: labelFileContents })
    gh.route('GET', `${repo}/issues/1`, { status: 200, body: { labels: [{ name: 'level/sandbox' }] } })
    gh.route('DELETE', `${repo}/issues/1/labels/level%2Fsandbox`, { status: 200, body: [] })
    gh.route('GET', `${repo}/labels`, repoLabels('level/sandbox', 'level/incubation'))
    gh.route('POST', `${repo}/issues/1/labels`, { status: 200, body: [] })

    const result = await runBundle({
      eventName: 'issue_comment',
      payload: comment('/level incubation'),
      inputs: { ...token, 'prow-commands': '/level' },
      apiUrl: gh.url,
    })

    expect(result.status, result.stdout).toBe(0)
    expect(result.errors).toEqual([])
    const posts = gh.requestsMatching('POST', /\/issues\/1\/labels$/)
    expect(posts).toHaveLength(1)
    expect(posts[0].body).toEqual({ labels: ['level/incubation'] })
    expectRequests(configReads({ repo: '.prowlabels.yaml' }), [
      `GET ${repo}/issues/1`,
      `DELETE ${repo}/issues/1/labels/level%2Fsandbox`,
      labelsRead,
      `POST ${repo}/issues/1/labels`,
    ])
  })

  it('issue_comment /help adds help wanted without reading .prowlabels.yaml', async () => {
    gh.route('GET', `${repo}/labels`, repoLabels('help wanted'))
    gh.route('POST', `${repo}/issues/1/labels`, { status: 200, body: [] })

    const result = await runBundle({
      eventName: 'issue_comment',
      payload: comment('/help'),
      inputs: { ...token, 'prow-commands': '/help' },
      apiUrl: gh.url,
    })

    expect(result.status, result.stdout).toBe(0)
    expect(result.errors).toEqual([])
    const posts = gh.requestsMatching('POST', /\/issues\/1\/labels$/)
    expect(posts).toHaveLength(1)
    expect(posts[0].body).toEqual({ labels: ['help wanted'] })
    expect(gh.requests.map(r => `${r.method} ${r.path}`)).toEqual([
      labelsRead,
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

  describe('issue_comment /approve on a pull request', () => {
    const ownersFiles: Record<string, string> = {
      'OWNERS': 'approvers:\n- alice\n',
      'sdk/OWNERS': 'approvers:\n- bob\n',
      'olm/OWNERS': 'options:\n  no_parent_owners: true\napprovers:\n- carol\n',
    }

    function routeOwners(files: string[]) {
      gh.route('GET', `${repo}/pulls/1`, { status: 200, body: { base: { sha: 'basesha' } } })
      gh.route('GET', `${repo}/pulls/1/files`, {
        status: 200,
        body: files.map(filename => ({ filename, status: 'modified' })),
      })
      gh.route('GET', `${repo}/git/trees/basesha`, {
        status: 200,
        body: {
          sha: 'basesha',
          truncated: false,
          tree: Object.keys(ownersFiles).map(path => ({ path, type: 'blob', sha: blobSha(path) })),
        },
      })
      for (const [path, contents] of Object.entries(ownersFiles)) {
        gh.route('GET', `${repo}/git/blobs/${blobSha(path)}`, {
          status: 200,
          body: { encoding: 'base64', content: Buffer.from(contents).toString('base64') },
        })
      }
      gh.route('POST', `${repo}/pulls/1/reviews`, { status: 200, body: {} })
      gh.route('POST', `${repo}/issues/1/comments`, { status: 201, body: {} })
    }

    it('approves when a nested approver covers every changed file', async () => {
      routeOwners(['sdk/x.go', 'sdk/internal/y.go'])

      const result = await runBundle({
        eventName: 'issue_comment',
        payload: prCommentEvent('/approve', 'bob'),
        inputs: { ...token, 'prow-commands': '/approve' },
        apiUrl: gh.url,
      })

      expect(result.status, result.stdout).toBe(0)
      expect(result.errors).toEqual([])
      const reviews = gh.requestsMatching('POST', /\/pulls\/1\/reviews$/)
      expect(reviews).toHaveLength(1)
      expect(reviews[0].body).toEqual({ event: 'APPROVE', comments: [] })
      expect(gh.requestsMatching('POST', /\/issues\/1\/comments$/)).toEqual([])
      const calls = gh.requests.map(r => `${r.method} ${r.path}`)
      expect(calls.slice(0, 3)).toEqual([
        `GET ${repo}/pulls/1`,
        `GET ${repo}/pulls/1/files?per_page=100`,
        `GET ${repo}/git/trees/basesha?recursive=true`,
      ])
      // the blobs are fetched concurrently, so their order is not fixed
      expect(calls.slice(3, 5).sort()).toEqual([
        `GET ${repo}/git/blobs/${blobSha('OWNERS')}`,
        `GET ${repo}/git/blobs/${blobSha('sdk/OWNERS')}`,
      ])
      expect(calls.slice(5)).toEqual([`POST ${repo}/pulls/1/reviews`])
    })

    it('refuses with a comment naming the file outside the approver\'s directory', async () => {
      routeOwners(['sdk/x.go', 'olm/y.go'])

      const result = await runBundle({
        eventName: 'issue_comment',
        payload: prCommentEvent('/approve', 'bob'),
        inputs: { ...token, 'prow-commands': '/approve' },
        apiUrl: gh.url,
      })

      const wantErr = 'bob is not an approver for olm/y.go (OWNERS: olm/OWNERS)'
      expect(result.status, result.stdout).toBe(1)
      expect(result.errors.some(e => e.includes(wantErr))).toBe(true)
      expect(gh.requestsMatching('POST', /\/pulls\/1\/reviews$/)).toEqual([])
      const comments = gh.requestsMatching('POST', /\/issues\/1\/comments$/)
      expect(comments).toHaveLength(1)
      expect(comments[0].body).toEqual({ body: `Cannot approve the pull request: Error: ${wantErr}` })
      expect(gh.requestsMatching('GET', /\/contents\//)).toEqual([])
    })
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
    function routePulls(pr: unknown, merge: { status: number, body: unknown } = { status: 200, body: { merged: true } }) {
      gh.route('GET', new RegExp(`^${repo}/pulls\\?`), (req) => {
        const page = new URL(req.path, gh.url).searchParams.get('page')
        return { status: 200, body: page === '1' ? [pr] : [] }
      })
      gh.route('PUT', `${repo}/pulls/2/merge`, merge)
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

    it('fails the run when a merge is refused', async () => {
      routePulls(openPr(['lgtm']), { status: 405, body: { message: 'Pull Request is not mergeable' } })

      const result = await runCron()

      expect(result.status, result.stdout).toBe(1)
      expect(result.errors.some(e => e.includes('could not merge pr #2'))).toBe(true)
      expect(result.errors.some(e => e.includes('1 pull request(s) could not be merged: #2 (Pull Request is not mergeable)'))).toBe(true)
      expect(gh.requestsMatching('PUT', /\/pulls\/2\/merge$/)).toHaveLength(1)
      expect(gh.requests.map(r => `${r.method} ${r.path}`)).toEqual([
        `GET ${repo}/pulls?state=open&page=1`,
        `PUT ${repo}/pulls/2/merge`,
        `GET ${repo}/pulls?state=open&page=2`,
      ])
    })
  })
})
