import type { FakeGithub } from './fakeGithub'
import { Buffer } from 'node:buffer'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import process from 'node:process'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import issueCommentEvent from '../fixtures/issues/issueCommentEvent.json'
import issuesLabeledEvent from '../fixtures/issues/issuesLabeledEvent.json'
import labelFileContents from '../fixtures/labels/labelFileContentsResp.json'
import checkSuiteCompletedEvent from '../fixtures/pullReq/checkSuiteCompletedEvent.json'
import pullReqListPulls from '../fixtures/pullReq/pullReqListPulls.json'
import pullReqOpenedEvent from '../fixtures/pullReq/pullReqOpenedEvent.json'
import pullReqReviewSubmittedEvent from '../fixtures/pullReq/pullReqReviewSubmittedEvent.json'
import { blobSha, prCommentEvent, pullBody } from '../utils/ownersFixtures'
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
  // github.com answers the state query for any pull request; "no merge queue" is the default a test overrides by routing first
  beforeEach(() => gh.mergeQueueFallback({ pullRequestId: 'PR_none', headOid: pullReqOpenedEvent.pull_request.head.sha, enabled: false }))
  afterEach(() => gh.reset())
  afterAll(() => gh.close())

  // the org and repo tiers are probed concurrently, so the reads have no fixed order among themselves
  function expectRequests(reads: string[], rest: string[]) {
    const calls = gh.requests.map(r => `${r.method} ${r.path}`)
    expect(calls.slice(0, reads.length).sort()).toEqual([...reads].sort())
    expect(calls.slice(reads.length)).toEqual(rest)
  }

  // a label command that never reads the configuration, then the sweep that follows it: the configuration
  // reads (unordered) for the needs-* re-check and, on a pull request, tide's calls
  function expectCommandThenSweep(command: string[], sweep: string[] = []) {
    const calls = gh.requests.map(r => `${r.method} ${r.path}`)
    expect(calls.slice(0, command.length)).toEqual(command)
    const reads = configReads()
    expect(calls.slice(command.length, command.length + reads.length).sort()).toEqual([...reads].sort())
    expect(calls.slice(command.length + reads.length)).toEqual(sweep)
  }

  // the pull request, its changed files, the tip of its base branch and the OWNERS files there, as the OWNERS plugins read them
  function routeOwners(ownersFiles: Record<string, string>, files: string[], pull: Record<string, unknown> = {}) {
    gh.route('GET', `${repo}/pulls/1`, { status: 200, body: { ...pullBody, user: { login: 'Codertocat' }, requested_reviewers: [], assignees: [], ...pull } })
    gh.route('GET', `${repo}/pulls/1/files`, {
      status: 200,
      body: files.map(filename => ({ filename, status: 'modified' })),
    })
    gh.route('GET', `${repo}/branches/master`, { status: 200, body: { name: 'master', commit: { sha: 'basesha' } } })
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
  }

  const ownersReads = [
    `GET ${repo}/pulls/1`,
    `GET ${repo}/pulls/1/files?per_page=100`,
    `GET ${repo}/branches/master`,
    `GET ${repo}/git/trees/basesha?recursive=true`,
  ]

  // the tide gate learns whether the pull request's base branch (master in every fixture) has OWNERS files from
  // its tree, once per branch per run, after the pull request read that names the branch; the fake answers 404
  // (an empty repository) unless a test routes it
  const ownersProbe = `GET ${repo}/git/trees/master?recursive=true`
  // tide asks GraphQL once whether the base branch requires a merge queue: once the gate passes, or when it
  // fails on an event (to dequeue the bot's own entry); the fake answers "no queue" unless a test routes it
  const queueRead = 'POST /graphql'

  it('is a syntactically valid bundle with no unresolved modules', () => {
    expect(fs.existsSync(bundlePath)).toBe(true)

    const check = spawnSync(process.execPath, ['--check', bundlePath], { encoding: 'utf8' })
    expect(check.status, check.stderr).toBe(0)

    expect(fs.readFileSync(bundlePath, 'utf8')).not.toContain('webpackMissingModule')
  })

  it('logs an error for an unsupported event without failing or calling the api', async () => {
    const result = await runBundle({ eventName: 'release', payload: {}, inputs: token, apiUrl: gh.url })

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('release not yet supported')
    expect(result.errors).toEqual(['release not yet supported'])
    expect(gh.requests).toEqual([])
  })

  it.each([
    ['pull_request_review', { ...pullReqReviewSubmittedEvent, action: 'edited' }],
    ['check_suite', { ...checkSuiteCompletedEvent, check_suite: { ...checkSuiteCompletedEvent.check_suite, conclusion: 'failure' } }],
    ['status', { sha: checkSuiteCompletedEvent.check_suite.head_sha, state: 'pending', repository: checkSuiteCompletedEvent.repository }],
  ])('%s is routed and exits 0 without calling the api when tide has nothing to gain', async (eventName, payload) => {
    const result = await runBundle({ eventName, payload, inputs: token, apiUrl: gh.url })

    expect(result.status, result.stdout).toBe(0)
    expect(result.errors).toEqual([])
    expect(result.stdout).not.toContain('not yet supported')
    expect(gh.requests).toEqual([])
  })

  it.each([
    ['pull_request', { ...pullReqOpenedEvent, action: 'labeled', label: { name: 'lgtm' } }],
    ['pull_request_review', pullReqReviewSubmittedEvent],
  ])('%s for a fork pull request exits 0 with a notice and no api call: the token is read-only', async (eventName, payload) => {
    const fork = { ...payload, pull_request: { ...payload.pull_request, head: { ...payload.pull_request.head, repo: { full_name: 'octocat/Hello-World' } } } }

    const result = await runBundle({ eventName, payload: fork, inputs: { ...token, jobs: 'lgtm' }, apiUrl: gh.url })

    expect(result.status, result.stdout).toBe(0)
    expect(result.errors).toEqual([])
    expect(result.stdout).toContain(`::notice::fork pull request under ${eventName}: the token is read-only; the sweep job handles it`)
    expect(gh.requests).toEqual([])
  })

  it('issues labeled with no require_matching_label configured only reads the configuration', async () => {
    const result = await runBundle({ eventName: 'issues', payload: issuesLabeledEvent, inputs: token, apiUrl: gh.url })

    expect(result.status, result.stdout).toBe(0)
    expect(result.errors).toEqual([])
    expect(result.stdout).not.toContain('not yet supported')
    expectRequests(configReads(), [])
  })

  describe('issues require-matching-label', () => {
    const needsKindComment = 'Please add a kind label.'
    const marker = '<!-- prow-github-actions/require-matching-label: needs-kind -->'

    function routeOrgRule() {
      gh.route('GET', '/repos/Codertocat/.project/contents/prow.yaml', {
        status: 200,
        body: yamlFile(`require_matching_label:\n  - regexp: ^kind/\n    missing_label: needs-kind\n    missing_comment: ${needsKindComment}\n`),
      })
      gh.route('GET', `${repo}/labels`, repoLabels('needs-kind', 'kind/bug'))
      gh.route('POST', `${repo}/issues/1/labels`, { status: 200, body: [] })
      gh.route('DELETE', `${repo}/issues/1/labels/needs-kind`, { status: 200, body: [] })
      gh.route('POST', `${repo}/issues/1/comments`, { status: 201, body: {} })
      gh.route('DELETE', `${repo}/issues/comments/11`, { status: 204 })
    }

    it('opened without a kind label adds needs-kind and posts the marked comment', async () => {
      routeOrgRule()
      gh.route('GET', `${repo}/issues/1`, { status: 200, body: { labels: [] } })
      gh.route('GET', `${repo}/issues/1/comments`, { status: 200, body: [] })

      const result = await runBundle({
        eventName: 'issues',
        payload: { ...issuesLabeledEvent, action: 'opened', issue: { ...issuesLabeledEvent.issue, labels: [] } },
        inputs: token,
        apiUrl: gh.url,
      })

      expect(result.status, result.stdout).toBe(0)
      expect(result.errors).toEqual([])
      const labels = gh.requestsMatching('POST', /\/issues\/1\/labels$/)
      expect(labels).toHaveLength(1)
      expect(labels[0].body).toEqual({ labels: ['needs-kind'] })
      const comments = gh.requestsMatching('POST', /\/issues\/1\/comments$/)
      expect(comments).toHaveLength(1)
      expect(comments[0].body).toEqual({ body: `${needsKindComment}\n\n${marker}` })
      expectRequests(configReads({ org: '.project' }), [
        `GET ${repo}/issues/1`,
        labelsRead,
        `POST ${repo}/issues/1/labels`,
        `GET ${repo}/issues/1/comments?per_page=100`,
        `POST ${repo}/issues/1/comments`,
      ])
    })

    it('labeled kind/bug with needs-kind present removes the label and the bot comment', async () => {
      routeOrgRule()
      gh.route('GET', `${repo}/issues/1`, { status: 200, body: { labels: [{ name: 'kind/bug' }, { name: 'needs-kind' }] } })
      gh.route('GET', `${repo}/issues/1/comments`, {
        status: 200,
        body: [
          { id: 11, body: `${needsKindComment}\n\n${marker}`, user: { login: 'github-actions[bot]', type: 'Bot' } },
          { id: 12, body: 'a human comment', user: { login: 'Codertocat', type: 'User' } },
        ],
      })

      const result = await runBundle({ eventName: 'issues', payload: issuesLabeledEvent, inputs: token, apiUrl: gh.url })

      expect(result.status, result.stdout).toBe(0)
      expect(result.errors).toEqual([])
      expect(gh.requestsMatching('POST', /./)).toEqual([])
      expectRequests(configReads({ org: '.project' }), [
        `GET ${repo}/issues/1`,
        `DELETE ${repo}/issues/1/labels/needs-kind`,
        `GET ${repo}/issues/1/comments?per_page=100`,
        `DELETE ${repo}/issues/comments/11`,
      ])
    })

    it('issue_comment /check-required-labels re-evaluates the rules without a grace period', async () => {
      routeOrgRule()
      gh.route('GET', `${repo}/issues/1`, { status: 200, body: { labels: [] } })
      gh.route('GET', `${repo}/issues/1/comments`, { status: 200, body: [] })

      const result = await runBundle({
        eventName: 'issue_comment',
        payload: comment('/check-required-labels'),
        inputs: { ...token, 'prow-commands': '/check-required-labels' },
        apiUrl: gh.url,
      })

      expect(result.status, result.stdout).toBe(0)
      expect(result.errors).toEqual([])
      expect(gh.requestsMatching('POST', /\/issues\/1\/labels$/)[0].body).toEqual({ labels: ['needs-kind'] })
      expectRequests(configReads({ org: '.project' }), [
        `GET ${repo}/issues/1`,
        labelsRead,
        `POST ${repo}/issues/1/labels`,
        `GET ${repo}/issues/1/comments?per_page=100`,
        `POST ${repo}/issues/1/comments`,
      ])
    })
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
    expectCommandThenSweep([labelsRead, `POST ${repo}/issues/1/labels`])
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
    const marker = '<!-- prow-github-actions/approve -->'
    const bot = { login: 'github-actions[bot]', type: 'Bot' }

    function routeApprove(files: string[], options: { labels?: string[], comments?: unknown[], reviews?: unknown[] } = {}) {
      routeOwners(ownersFiles, files, { labels: (options.labels ?? []).map(name => ({ name })) })
      gh.route('GET', `${repo}/issues/1/comments`, { status: 200, body: options.comments ?? [] })
      gh.route('GET', `${repo}/pulls/1/reviews`, { status: 200, body: options.reviews ?? [] })
      gh.route('GET', `${repo}/labels`, repoLabels('approved', 'lgtm'))
      gh.route('POST', `${repo}/issues/1/labels`, { status: 200, body: [] })
      gh.route('DELETE', `${repo}/issues/1/labels/approved`, { status: 200, body: [] })
      gh.route('POST', `${repo}/pulls/1/reviews`, { status: 200, body: {} })
      gh.route('POST', `${repo}/issues/1/comments`, { status: 201, body: {} })
      gh.route('PATCH', `${repo}/issues/comments/900`, { status: 200, body: {} })
    }

    function runApprove(body: string, commenter: string) {
      return runBundle({
        eventName: 'issue_comment',
        payload: prCommentEvent(body, commenter),
        inputs: { ...token, 'prow-commands': '/approve' },
        apiUrl: gh.url,
      })
    }

    it('/approve by an approver covering every changed file adds approved and posts the notifier; no bot review', async () => {
      routeApprove(['sdk/x.go', 'sdk/internal/y.go'], {
        comments: [{ id: 1, body: '/approve', user: { login: 'bob', type: 'User' }, created_at: '2024-01-01T00:00:01Z' }],
      })

      const result = await runApprove('/approve', 'bob')

      expect(result.status, result.stdout).toBe(0)
      expect(result.errors).toEqual([])
      expect(result.stdout).toContain('approve: #1 is approved by bob')
      expect(gh.requestsMatching('POST', /\/pulls\/1\/reviews$/)).toEqual([])
      expect(gh.requestsMatching('POST', /\/issues\/1\/labels$/).map(r => r.body)).toEqual([{ labels: ['approved'] }])
      const comments = gh.requestsMatching('POST', /\/issues\/1\/comments$/)
      expect(comments).toHaveLength(1)
      const body = (comments[0].body as { body: string }).body
      expect(body).toContain('[APPROVALNOTIFIER] This PR is **APPROVED**')
      expect(body).toContain(`~~[sdk/OWNERS](https://github.com/Codertocat/Hello-World/blob/basesha/sdk/OWNERS)~~ [bob]`)
      expect(body.endsWith(marker)).toBe(true)
      // the OWNERS reads (memoized across the authorization and the evaluation), the config probes, then one evaluation
      const calls = gh.requests.map(r => `${r.method} ${r.path}`)
      expect(calls.slice(0, 4)).toEqual(ownersReads)
      expect(calls.slice(4, 6).sort()).toEqual([
        `GET ${repo}/git/blobs/${blobSha('OWNERS')}`,
        `GET ${repo}/git/blobs/${blobSha('sdk/OWNERS')}`,
      ])
      expect(calls.slice(6, 6 + configReads().length).sort()).toEqual(configReads().sort())
      // then the sweep: tide reads the pr and probes its base branch for OWNERS files (approved alone is not the gate)
      expect(calls.slice(6 + configReads().length)).toEqual([
        `GET ${repo}/issues/1/comments?per_page=100`,
        `GET ${repo}/pulls/1/reviews?per_page=100`,
        labelsRead,
        `POST ${repo}/issues/1/labels`,
        `POST ${repo}/issues/1/comments`,
        `GET ${repo}/pulls/1`,
        ownersProbe,
        queueRead,
      ])
      expect(calls).toHaveLength(6 + configReads().length + 8)
    })

    it('/approve cancel removes approved and edits the notifier to NOT APPROVED; the merge gate then misses approved', async () => {
      // the first route wins in the fake: the pr's labels follow the removal so that tide sees the withdrawn approval
      const labels = new Set(['approved', 'lgtm'])
      gh.route('DELETE', `${repo}/issues/1/labels/approved`, () => {
        labels.delete('approved')
        return { status: 200, body: [] }
      })
      gh.route('GET', `${repo}/pulls/1`, () => ({ status: 200, body: { ...pullBody, user: { login: 'some-author' }, requested_reviewers: [], assignees: [], labels: [...labels].map(name => ({ name })) } }))
      gh.route('GET', `${repo}/git/trees/master`, { status: 200, body: { sha: 'master', truncated: false, tree: [{ path: 'OWNERS', type: 'blob', sha: 'o' }] } })
      routeApprove(['sdk/x.go'], {
        labels: ['approved', 'lgtm'],
        comments: [
          { id: 900, body: `stale\n${marker}`, user: bot, created_at: '2024-01-01T00:00:00Z' },
          { id: 1, body: '/approve', user: { login: 'bob', type: 'User' }, created_at: '2024-01-01T00:00:01Z' },
          { id: 2, body: '/approve cancel', user: { login: 'bob', type: 'User' }, created_at: '2024-01-01T00:00:02Z' },
        ],
      })

      const result = await runApprove('/approve cancel', 'bob')

      expect(result.status, result.stdout).toBe(0)
      expect(result.errors).toEqual([])
      expect(gh.requestsMatching('DELETE', /\/issues\/1\/labels\/approved$/)).toHaveLength(1)
      expect(gh.requestsMatching('POST', /\/issues\/1\/comments$/)).toEqual([])
      const patches = gh.requestsMatching('PATCH', /\/issues\/comments\/900$/)
      expect(patches).toHaveLength(1)
      expect((patches[0].body as { body: string }).body).toContain('This PR is **NOT APPROVED**')
      expect(gh.requestsMatching('PUT', /dismissals$/)).toEqual([])
      expect(result.stdout).toContain('skipping pr #1: missing approved')
      expect(gh.requestsMatching('PUT', /merge$/)).toEqual([])
    })

    it('refuses with a comment a commenter who approves none of the changed files', async () => {
      routeApprove(['sdk/x.go', 'olm/y.go'])

      const result = await runApprove('/approve', 'rita')

      const wantErr = 'rita is not an approver for any changed file'
      expect(result.status, result.stdout).toBe(1)
      expect(result.errors.some(e => e.includes(wantErr))).toBe(true)
      expect(gh.requestsMatching('POST', /\/pulls\/1\/reviews$/)).toEqual([])
      expect(gh.requestsMatching('POST', /\/issues\/1\/labels$/)).toEqual([])
      const comments = gh.requestsMatching('POST', /\/issues\/1\/comments$/)
      expect(comments).toHaveLength(1)
      expect(comments[0].body).toEqual({ body: `Cannot approve the pull request: Error: ${wantErr}` })
      expect(gh.requestsMatching('GET', /\/issues\/1\/comments/)).toEqual([])
    })

    it('an approver of one of two directories gets no label and a notifier suggesting the other approver', async () => {
      routeApprove(['sdk/x.go', 'olm/y.go'], {
        comments: [{ id: 1, body: '/approve', user: { login: 'bob', type: 'User' }, created_at: '2024-01-01T00:00:01Z' }],
      })

      const result = await runApprove('/approve', 'bob')

      expect(result.status, result.stdout).toBe(0)
      expect(result.errors).toEqual([])
      expect(gh.requestsMatching('POST', /\/issues\/1\/labels$/)).toEqual([])
      const body = (gh.requestsMatching('POST', /\/issues\/1\/comments$/)[0].body as { body: string }).body
      expect(body).toContain('This PR is **NOT APPROVED**')
      expect(body).toContain('please assign **carol**')
    })

    it('a pr opened before the OWNERS files landed on its base (cncf/automation#709): approved is granted from the branch tip, and the gate asks for it', async () => {
      // the first route wins: base.sha is the OWNERS-less snapshot, the branch has moved on to a tip with OWNERS
      gh.route('GET', `${repo}/pulls/1`, { status: 200, body: { ...pullBody, base: { ref: 'master', sha: 'old' }, labels: [{ name: 'lgtm' }], user: { login: 'some-author' }, requested_reviewers: [], assignees: [] } })
      gh.route('GET', `${repo}/branches/master`, { status: 200, body: { name: 'master', commit: { sha: 'new' } } })
      gh.route('GET', `${repo}/git/trees/old`, { status: 200, body: { sha: 'old', truncated: false, tree: [] } })
      gh.route('GET', `${repo}/git/trees/new`, { status: 200, body: { sha: 'new', truncated: false, tree: [{ path: 'OWNERS', type: 'blob', sha: blobSha('OWNERS') }] } })
      gh.route('GET', `${repo}/git/trees/master`, { status: 200, body: { sha: 'new', truncated: false, tree: [{ path: 'OWNERS', type: 'blob', sha: blobSha('OWNERS') }] } })
      routeApprove(['src/a.go'], {
        comments: [{ id: 1, body: '/approve', user: { login: 'alice', type: 'User' }, created_at: '2024-01-01T00:00:01Z' }],
      })

      const result = await runApprove('/approve', 'alice')

      expect(result.status, result.stdout).toBe(0)
      expect(result.errors).toEqual([])
      expect(gh.requestsMatching('POST', /\/pulls\/1\/reviews$/)).toEqual([])
      expect(gh.requestsMatching('POST', /\/issues\/1\/labels$/).map(r => r.body)).toEqual([{ labels: ['approved'] }])
      const body = (gh.requestsMatching('POST', /\/issues\/1\/comments$/)[0].body as { body: string }).body
      expect(body).toContain('This PR is **APPROVED**')
      expect(body).toContain(`~~[OWNERS](https://github.com/Codertocat/Hello-World/blob/new/OWNERS)~~ [alice]`)
      expect(gh.requestsMatching('GET', /\/git\/trees\/old/)).toEqual([])
      expect(gh.requestsMatching('GET', /\/git\/trees\/new/)).toHaveLength(1)
      // the gate read the same branch: lgtm alone no longer merges, approved (just granted) is required
      expect(result.stdout).toContain('skipping pr #1: missing approved')
      expect(gh.requestsMatching('PUT', /merge$/)).toEqual([])
    })

    it('on a repository without OWNERS files /approve still submits a bot review and touches no label', async () => {
      routeOwners({}, ['src/file1.txt'])
      gh.route('GET', `/orgs/Codertocat/members/bob`, { status: 204 })
      gh.route('POST', `${repo}/pulls/1/reviews`, { status: 200, body: {} })

      const result = await runApprove('/approve', 'bob')

      expect(result.status, result.stdout).toBe(0)
      expect(result.errors).toEqual([])
      const reviews = gh.requestsMatching('POST', /\/pulls\/1\/reviews$/)
      expect(reviews).toHaveLength(1)
      expect(reviews[0].body).toEqual({ event: 'APPROVE', comments: [] })
      expect(gh.requestsMatching('POST', /\/issues\/1\/labels$/)).toEqual([])
      expect(gh.requestsMatching('POST', /\/issues\/1\/comments$/)).toEqual([])
      // the membership fallback checks org membership and collaborator status; the sweep then reads the configuration and the pr
      expectCommandThenSweep([
        ...ownersReads,
        `GET /orgs/Codertocat/members/bob`,
        `GET ${repo}/collaborators/bob`,
        `POST ${repo}/pulls/1/reviews`,
      ], [`GET ${repo}/pulls/1`, ownersProbe, queueRead])
    })
  })

  describe('issue_comment trigger commands on a pull request', () => {
    const runsOnHead = {
      total_count: 4,
      workflow_runs: [
        { id: 1, name: 'CI', path: '.github/workflows/ci.yml', head_sha: 'headsha', status: 'completed', conclusion: 'failure' },
        { id: 2, name: 'Lint', path: '.github/workflows/lint.yml', head_sha: 'headsha', status: 'completed', conclusion: 'success' },
        { id: 3, name: 'Prow', path: '.github/workflows/prow.yml', head_sha: 'headsha', status: 'in_progress', conclusion: null },
        { id: 4, name: 'E2E', path: '.github/workflows/e2e.yml', head_sha: 'headsha', status: 'action_required', conclusion: 'action_required' },
      ],
    }

    function routeTrigger() {
      routeOwners({}, ['src/file1.txt'])
      gh.route('GET', '/orgs/Codertocat/members/Codertocat', { status: 204 })
      gh.route('GET', `${repo}/collaborators/Codertocat`, { status: 404, body: { message: 'Not Found' } })
      gh.route('GET', `${repo}/actions/runs`, { status: 200, body: runsOnHead })
      gh.route('POST', /\/actions\/runs\/\d+\/rerun-failed-jobs$/, { status: 201 })
      gh.route('POST', /\/actions\/runs\/\d+\/approve$/, { status: 201 })
      gh.route('POST', `${repo}/issues/comments/492700400/reactions`, { status: 201, body: { content: 'rocket' } })
    }

    const authReads = [...ownersReads, `GET /orgs/Codertocat/members/Codertocat`, `GET ${repo}/collaborators/Codertocat`]
    const runsRead = `GET ${repo}/actions/runs?head_sha=headsha&per_page=100`
    const rocket = `POST ${repo}/issues/comments/492700400/reactions`

    it('/retest re-runs the failed jobs of the failed run only and reacts with a rocket; no sweep follows', async () => {
      routeTrigger()

      const result = await runBundle({
        eventName: 'issue_comment',
        payload: prCommentEvent('/retest'),
        inputs: { ...token, 'prow-commands': '/retest' },
        apiUrl: gh.url,
        env: { GITHUB_WORKFLOW: 'Prow' },
      })

      expect(result.status, result.stdout).toBe(0)
      expect(result.errors).toEqual([])
      const calls = gh.requests.map(r => `${r.method} ${r.path}`)
      expect(calls.slice(0, authReads.length).sort()).toEqual([...authReads].sort())
      expect(calls.slice(authReads.length)).toEqual([runsRead, `POST ${repo}/actions/runs/1/rerun-failed-jobs`, rocket])
      expect(gh.requestsMatching('POST', /\/reactions$/)[0].body).toEqual({ content: 'rocket' })
    })

    it('/ok-to-test approves the run awaiting approval, labels ok-to-test, reacts, then the post-command sweep skips the unlgtm\'d pr', async () => {
      routeTrigger()
      gh.route('GET', `${repo}/issues/1`, { status: 200, body: { labels: [] } })
      gh.route('GET', `${repo}/labels`, repoLabels('ok-to-test', 'lgtm'))
      gh.route('POST', `${repo}/issues/1/labels`, { status: 200, body: [] })

      const result = await runBundle({
        eventName: 'issue_comment',
        payload: prCommentEvent('/ok-to-test'),
        inputs: { ...token, 'prow-commands': '/ok-to-test' },
        apiUrl: gh.url,
        env: { GITHUB_WORKFLOW: 'Prow' },
      })

      expect(result.status, result.stdout).toBe(0)
      expect(result.errors).toEqual([])
      expect(result.stdout).toContain('skipping pr #1: missing lgtm')
      const calls = gh.requests.map(r => `${r.method} ${r.path}`)
      expect(calls.slice(0, authReads.length).sort()).toEqual([...authReads].sort())
      const command = [runsRead, `POST ${repo}/actions/runs/4/approve`, `GET ${repo}/issues/1`, labelsRead, `POST ${repo}/issues/1/labels`, rocket]
      expect(calls.slice(authReads.length, authReads.length + command.length)).toEqual(command)
      expect(gh.requestsMatching('POST', /\/issues\/1\/labels$/)[0].body).toEqual({ labels: ['ok-to-test'] })
      expect(gh.requestsMatching('POST', /\/issues\/1\/comments$/)).toEqual([])
      expect(gh.requestsMatching('POST', /\/rerun/)).toEqual([])
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
    expectCommandThenSweep([
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

  it('issue_comment /hold applies do-not-merge/hold', async () => {
    gh.route('GET', `${repo}/labels`, repoLabels('do-not-merge/hold', 'hold'))
    gh.route('POST', `${repo}/issues/1/labels`, { status: 200, body: [] })

    const result = await runBundle({
      eventName: 'issue_comment',
      payload: comment('/hold'),
      inputs: { ...token, 'prow-commands': '/hold' },
      apiUrl: gh.url,
    })

    expect(result.status, result.stdout).toBe(0)
    expect(result.errors).toEqual([])
    const posts = gh.requestsMatching('POST', /\/issues\/1\/labels$/)
    expect(posts).toHaveLength(1)
    expect(posts[0].body).toEqual({ labels: ['do-not-merge/hold'] })
    expectRequests(configReads(), [labelsRead, `POST ${repo}/issues/1/labels`])
  })

  it('issue_comment /unhold removes do-not-merge/hold and the legacy hold label when /hold is configured', async () => {
    gh.route('GET', `${repo}/issues/1`, { status: 200, body: { labels: [{ name: 'hold' }, { name: 'do-not-merge/hold' }] } })
    gh.route('DELETE', new RegExp(`^${repo}/issues/1/labels/`), { status: 200, body: [] })

    const result = await runBundle({
      eventName: 'issue_comment',
      payload: comment('/unhold'),
      inputs: { ...token, 'prow-commands': '/hold' },
      apiUrl: gh.url,
    })

    expect(result.status, result.stdout).toBe(0)
    expect(result.errors).toEqual([])
    expectRequests(configReads(), [
      `GET ${repo}/issues/1`,
      `DELETE ${repo}/issues/1/labels/hold`,
      `DELETE ${repo}/issues/1/labels/do-not-merge%2Fhold`,
    ])
  })

  it('pull_request lgtm job removes the lgtm label on a new push', async () => {
    routeOwners({}, ['src/file1.txt'])
    gh.route('GET', `${repo}/issues/1`, { status: 200, body: { labels: [{ name: 'lgtm' }] } })
    gh.route('DELETE', `${repo}/issues/1/labels/lgtm`, { status: 200, body: [] })

    const result = await runBundle({
      eventName: 'pull_request',
      payload: { ...pullReqOpenedEvent, action: 'synchronize' },
      inputs: { ...token, jobs: 'lgtm' },
      apiUrl: gh.url,
    })

    expect(result.status, result.stdout).toBe(0)
    expect(result.errors).toEqual([])
    // owners-label reads the (OWNERS-less) base tree on synchronize, approve probes the default branch, then the lgtm job runs
    expect(gh.requests.map(r => `${r.method} ${r.path}`)).toEqual([
      ...ownersReads,
      ownersProbe,
      `GET ${repo}/issues/1`,
      `DELETE ${repo}/issues/1/labels/lgtm`,
    ])
  })

  it('pull_request_target lgtm job removes the lgtm label on a new push', async () => {
    routeOwners({}, ['src/file1.txt'])
    gh.route('GET', `${repo}/issues/1`, { status: 200, body: { labels: [{ name: 'lgtm' }] } })
    gh.route('DELETE', `${repo}/issues/1/labels/lgtm`, { status: 200, body: [] })

    const result = await runBundle({
      eventName: 'pull_request_target',
      payload: { ...pullReqOpenedEvent, action: 'synchronize' },
      inputs: { ...token, jobs: 'lgtm' },
      apiUrl: gh.url,
    })

    expect(result.status, result.stdout).toBe(0)
    expect(result.errors).toEqual([])
    // owners-label reads the (OWNERS-less) base tree on synchronize, approve probes the default branch, then the lgtm job runs
    expect(gh.requests.map(r => `${r.method} ${r.path}`)).toEqual([
      ...ownersReads,
      ownersProbe,
      `GET ${repo}/issues/1`,
      `DELETE ${repo}/issues/1/labels/lgtm`,
    ])
  })

  describe('pull_request owners-label and blunderbuss', () => {
    const ownersFiles: Record<string, string> = {
      'OWNERS': 'reviewers:\n- alice\n',
      'sdk/OWNERS': 'reviewers:\n- bob\n- carol\nlabels:\n- area/sdk\n',
    }
    const ownersBlobs = [`GET ${repo}/git/blobs/${blobSha('OWNERS')}`, `GET ${repo}/git/blobs/${blobSha('sdk/OWNERS')}`].sort()
    const requestReviewers = `POST ${repo}/pulls/1/requested_reviewers`

    function routeWrites() {
      gh.route('GET', `${repo}/issues/1`, { status: 200, body: { labels: [] } })
      gh.route('GET', `${repo}/labels`, repoLabels('area/sdk', 'kind/bug'))
      gh.route('POST', `${repo}/issues/1/labels`, { status: 200, body: [] })
      gh.route('POST', `${repo}/pulls/1/requested_reviewers`, { status: 201, body: {} })
    }

    function requestedReviewers(): string[] {
      const posts = gh.requestsMatching('POST', /\/pulls\/1\/requested_reviewers$/)
      expect(posts).toHaveLength(1)
      return [...(posts[0].body as { reviewers: string[] }).reviewers].sort()
    }

    it('opened: adds the OWNERS labels and requests two reviewers from the OWNERS, reading the pull request once', async () => {
      routeOwners(ownersFiles, ['sdk/x.go'])
      routeWrites()

      const result = await runBundle({ eventName: 'pull_request', payload: pullReqOpenedEvent, inputs: token, apiUrl: gh.url })

      expect(result.status, result.stdout).toBe(0)
      expect(result.errors).toEqual([])
      const labels = gh.requestsMatching('POST', /\/issues\/1\/labels$/)
      expect(labels).toHaveLength(1)
      expect(labels[0].body).toEqual({ labels: ['area/sdk'] })
      // every candidate covers the one changed file, so the pick is a random 2-subset
      const reviewers = requestedReviewers()
      expect(reviewers).toHaveLength(2)
      expect(['alice', 'bob', 'carol']).toEqual(expect.arrayContaining(reviewers))
      // require-matching-label's configuration probes interleave with the OWNERS plugins; the memo means one pull request read for both
      const calls = gh.requests.map(r => `${r.method} ${r.path}`)
      expect([...calls].sort()).toEqual([...configReads(), ...ownersReads, ...ownersBlobs, `GET ${repo}/issues/1`, labelsRead, `POST ${repo}/issues/1/labels`, requestReviewers, ownersProbe].sort())
      expect(calls.indexOf(`POST ${repo}/issues/1/labels`)).toBeGreaterThan(calls.indexOf(labelsRead))
      expect(calls.indexOf(requestReviewers)).toBeGreaterThan(calls.indexOf(`GET ${repo}/git/trees/basesha?recursive=true`))
    })

    it('synchronize: adds the missing labels only and requests no reviewers', async () => {
      routeOwners(ownersFiles, ['sdk/x.go'])
      routeWrites()

      const result = await runBundle({
        eventName: 'pull_request',
        payload: { ...pullReqOpenedEvent, action: 'synchronize' },
        inputs: token,
        apiUrl: gh.url,
      })

      expect(result.status, result.stdout).toBe(0)
      expect(result.errors).toEqual([])
      expect(gh.requestsMatching('POST', /\/issues\/1\/labels$/)[0].body).toEqual({ labels: ['area/sdk'] })
      expect(gh.requestsMatching('POST', /requested_reviewers$/)).toEqual([])
      const calls = gh.requests.map(r => `${r.method} ${r.path}`)
      expect(calls.slice(0, 4)).toEqual(ownersReads)
      expect(calls.slice(4, 6).sort()).toEqual(ownersBlobs)
      expect(calls.slice(6)).toEqual([
        `GET ${repo}/issues/1`,
        labelsRead,
        `POST ${repo}/issues/1/labels`,
        ownersProbe,
      ])
    })

    it('opened draft: labels it but waits for ready_for_review before requesting reviewers', async () => {
      routeOwners(ownersFiles, ['sdk/x.go'], { draft: true })
      routeWrites()

      const result = await runBundle({ eventName: 'pull_request', payload: pullReqOpenedEvent, inputs: token, apiUrl: gh.url })

      expect(result.status, result.stdout).toBe(0)
      expect(result.errors).toEqual([])
      expect(gh.requestsMatching('POST', /\/issues\/1\/labels$/)).toHaveLength(1)
      expect(gh.requestsMatching('POST', /requested_reviewers$/)).toEqual([])
    })

    it('issue_comment /auto-cc requests reviewers with the configured request_count', async () => {
      gh.route('GET', '/repos/Codertocat/.project/contents/prow.yaml', { status: 200, body: yamlFile('blunderbuss:\n  request_count: 1\n') })
      routeOwners(ownersFiles, ['sdk/x.go', 'README.md'], { draft: true })
      routeWrites()

      const result = await runBundle({
        eventName: 'issue_comment',
        payload: prCommentEvent('/auto-cc'),
        inputs: { ...token, 'prow-commands': '/auto-cc' },
        apiUrl: gh.url,
      })

      expect(result.status, result.stdout).toBe(0)
      expect(result.errors).toEqual([])
      // alice covers both changed files, so with request_count 1 she is the deterministic pick
      expect(requestedReviewers()).toEqual(['alice'])
      expect(gh.requestsMatching('POST', /\/issues\/1\/labels$/)).toEqual([])
      expectRequests([...configReads({ org: '.project' }), ...ownersReads, ...ownersBlobs], [requestReviewers])
    })
  })

  it('pull_request lgtm job leaves the lgtm label alone when the pr is labeled', async () => {
    gh.route('GET', `${repo}/issues/1`, { status: 200, body: { labels: [{ name: 'lgtm' }] } })
    gh.route('DELETE', `${repo}/issues/1/labels/lgtm`, { status: 200, body: [] })
    gh.route('GET', `${repo}/pulls/1`, { status: 200, body: openPr(['kind/bug'], { number: 1 }) })

    const result = await runBundle({
      eventName: 'pull_request',
      payload: { ...pullReqOpenedEvent, action: 'labeled', label: { name: 'kind/bug' } },
      inputs: { ...token, jobs: 'lgtm' },
      apiUrl: gh.url,
    })

    expect(result.status, result.stdout).toBe(0)
    expect(result.errors).toEqual([])
    // tide probes for OWNERS files, reads the pull request once and stops at the missing lgtm; the lgtm job does nothing on labeled
    expectRequests(configReads(), [`GET ${repo}/pulls/1`, ownersProbe, queueRead])
  })

  describe('event-driven merging', () => {
    const pullRead = `GET ${repo}/pulls/1`
    const merge = `PUT ${repo}/pulls/1/merge`
    // the fixtures' head commit: the payload's and the api's agree, as they do on GitHub
    const head = pullReqOpenedEvent.pull_request.head.sha
    const short = head.slice(0, 7)
    const bind = `POST ${repo}/statuses/${head}`
    const bindingRead = `GET ${repo}/commits/${head}/status?per_page=100`
    const bound = [{ context: 'prow/lgtm', state: 'success' }]

    function mergeablePr(state: string, labels = ['lgtm']) {
      return openPr(labels, { number: 1, mergeable: state === 'unknown' ? null : true, mergeable_state: state, head: { sha: head } })
    }

    function labeledLgtm(sender: Record<string, unknown> = pullReqOpenedEvent.sender) {
      return { ...pullReqOpenedEvent, action: 'labeled', label: { name: 'lgtm' }, sender }
    }

    function runPullRequest(payload: unknown, inputs: Record<string, string> = {}) {
      return runBundle({ eventName: 'pull_request', payload, inputs: { ...token, 'merge-method': 'squash', ...inputs }, apiUrl: gh.url })
    }

    it('pull_request labeled lgtm by a human: binds the label to the head, then squash-merges the clean pr', async () => {
      gh.commitStatuses(repo, head, bound)
      gh.route('GET', `${repo}/pulls/1`, { status: 200, body: mergeablePr('clean') })
      gh.route('PUT', `${repo}/pulls/1/merge`, { status: 200, body: { merged: true } })

      const result = await runPullRequest(labeledLgtm())

      expect(result.status, result.stdout).toBe(0)
      expect(result.errors).toEqual([])
      expect(result.stdout).toContain(`lgtm: bound the hand-applied label on #1 to ${short}`)
      expect(result.stdout).toContain('merged pr #1')
      const binds = gh.requestsMatching('POST', /\/statuses\//)
      expect(binds).toHaveLength(1)
      expect(binds[0].body).toEqual({ state: 'success', context: 'prow/lgtm', description: `lgtm by Codertocat at ${short}`, target_url: pullReqOpenedEvent.pull_request.html_url })
      const merges = gh.requestsMatching('PUT', /\/pulls\/1\/merge$/)
      expect(merges).toHaveLength(1)
      expect(merges[0].body).toEqual({ merge_method: 'squash', sha: head })
      expectRequests(configReads(), [bind, pullRead, ownersProbe, bindingRead, queueRead, merge])
    })

    describe('headline: an lgtm that is not bound to the head never merges', () => {
      const strip = [
        `DELETE ${repo}/issues/1/labels/lgtm`,
        bind,
        `GET ${repo}/issues/1/comments?per_page=100`,
        `POST ${repo}/issues/1/comments`,
      ]

      function routeStrip(sha = head) {
        gh.route('DELETE', `${repo}/issues/1/labels/lgtm`, { status: 200, body: [] })
        gh.route('GET', `${repo}/issues/1/comments`, { status: 200, body: [] })
        gh.route('POST', `${repo}/issues/1/comments`, { status: 201, body: {} })
        gh.commitStatuses(repo, sha, [])
      }

      function expectStripped(sha = head) {
        const pendings = gh.requestsMatching('POST', /\/statuses\//)
        expect(pendings).toHaveLength(1)
        expect(pendings[0].body).toEqual({ state: 'pending', context: 'prow/lgtm', description: `lgtm removed: not bound to ${sha.slice(0, 7)}` })
        expect(gh.requestsMatching('DELETE', /\/labels\/lgtm$/)).toHaveLength(1)
        const comments = gh.requestsMatching('POST', /\/issues\/1\/comments$/)
        expect(comments).toHaveLength(1)
        const body = (comments[0].body as { body: string }).body
        expect(body).toContain(`\`lgtm\` is not bound to the current head commit (\`${sha.slice(0, 7)}\`)`)
        expect(body).toContain(`<!-- prow-github-actions/lgtm-stale: ${sha.slice(0, 7)} -->`)
        expect(gh.requestsMatching('PUT', /./)).toEqual([])
      }

      it('pull_request labeled lgtm by a bot (no binding recorded) on a clean pr: stripped with one comment, not merged', async () => {
        routeStrip()
        gh.route('GET', `${repo}/pulls/1`, { status: 200, body: mergeablePr('clean') })
        gh.route('PUT', `${repo}/pulls/1/merge`, { status: 200, body: { merged: true } })

        const result = await runPullRequest(labeledLgtm({ login: 'some-app[bot]', type: 'Bot' }))

        expect(result.status, result.stdout).toBe(0)
        expect(result.errors).toEqual([])
        expect(result.stdout).toContain(`skipping pr #1: lgtm not bound to ${short}`)
        expectStripped()
        expectRequests(configReads(), [pullRead, ownersProbe, bindingRead, ...strip, queueRead])
      })

      it('pull_request labeled lgtm by a human when the status cannot be written: the run fails, and tide still strips the unbound label', async () => {
        // the first route wins in the fake: the refusal goes in before routeStrip's accepting status route
        gh.route('POST', `${repo}/statuses/${head}`, { status: 403, body: { message: 'Resource not accessible by integration' } })
        routeStrip()
        gh.route('GET', `${repo}/pulls/1`, { status: 200, body: mergeablePr('clean') })

        const result = await runPullRequest(labeledLgtm())

        expect(result.status, result.stdout).toBe(1)
        expect(result.errors.some(e => e.includes('cannot bind lgtm to the commit: grant `statuses: write` to the workflow'))).toBe(true)
        expect(gh.requestsMatching('DELETE', /\/labels\/lgtm$/)).toHaveLength(1)
        expect(gh.requestsMatching('PUT', /./)).toEqual([])
      })

      it('schedule jobs: lgtm on a clean lgtm pr whose head has no binding: stripped, not merged; the cron path is covered too', async () => {
        const sha = 'def0123456789abcdef0123456789abcdef01234'
        gh.route('GET', repo, { status: 200, body: { default_branch: 'master' } })
        gh.route('GET', new RegExp(`^${repo}/pulls\\?`), (req) => {
          const page = new URL(req.path, gh.url).searchParams.get('page')
          return { status: 200, body: page === '1' ? [openPr(['lgtm'], { number: 1, head: { sha } })] : [] }
        })
        gh.route('GET', `${repo}/pulls/1`, { status: 200, body: openPr(['lgtm'], { number: 1, mergeable: true, mergeable_state: 'clean', head: { sha } }) })
        gh.route('PUT', `${repo}/pulls/1/merge`, { status: 200, body: { merged: true } })
        routeStrip(sha)

        const result = await runBundle({ eventName: 'schedule', payload: {}, inputs: { ...token, jobs: 'lgtm' }, apiUrl: gh.url })

        expect(result.status, result.stdout).toBe(0)
        expect(result.errors).toEqual([])
        expect(result.stdout).toContain(`skipping pr #1: lgtm not bound to ${sha.slice(0, 7)}`)
        expectStripped(sha)
        expectRequests(configReads(), [
          `GET ${repo}/pulls?state=open&page=1`,
          ownersProbe,
          pullRead,
          `GET ${repo}/commits/${sha}/status?per_page=100`,
          `DELETE ${repo}/issues/1/labels/lgtm`,
          `POST ${repo}/statuses/${sha}`,
          `GET ${repo}/issues/1/comments?per_page=100`,
          `POST ${repo}/issues/1/comments`,
          `GET ${repo}/pulls?state=open&page=2`,
        ])
      })

      it('headline 2: the same pr with prow/lgtm success on its head merges, on the event and on the cron path', async () => {
        gh.commitStatuses(repo, head, bound)
        gh.route('GET', repo, { status: 200, body: { default_branch: 'master' } })
        gh.route('GET', new RegExp(`^${repo}/pulls\\?`), (req) => {
          const page = new URL(req.path, gh.url).searchParams.get('page')
          return { status: 200, body: page === '1' ? [mergeablePr('clean')] : [] }
        })
        gh.route('GET', `${repo}/pulls/1`, { status: 200, body: mergeablePr('clean') })
        gh.route('PUT', `${repo}/pulls/1/merge`, { status: 200, body: { merged: true } })

        const event = await runPullRequest(labeledLgtm({ login: 'some-app[bot]', type: 'Bot' }))
        expect(event.status, event.stdout).toBe(0)
        expect(event.stdout).toContain('merged pr #1')
        expectRequests(configReads(), [pullRead, ownersProbe, bindingRead, queueRead, merge])

        gh.requests.length = 0
        const cron = await runBundle({ eventName: 'schedule', payload: {}, inputs: { ...token, jobs: 'lgtm' }, apiUrl: gh.url })
        expect(cron.status, cron.stdout).toBe(0)
        expect(cron.stdout).toContain('merged pr #1')
        expectRequests(configReads(), [`GET ${repo}/pulls?state=open&page=1`, ownersProbe, pullRead, bindingRead, queueRead, merge, `GET ${repo}/pulls?state=open&page=2`])
        expect(gh.requestsMatching('DELETE', /./)).toEqual([])
      })
    })

    it('issue_comment /lgtm on a clean pr: labels, then squash-merges from tide.merge_method in the same run', async () => {
      gh.route('GET', `${repo}/contents/${encodeURIComponent('.github/prow.yaml')}`, { status: 200, body: yamlFile('tide:\n  merge_method: squash\n') })
      routeOwners({}, ['src/file1.txt'], { labels: [{ name: 'lgtm' }] })
      gh.route('GET', '/orgs/Codertocat/members/Codertocat', { status: 204 })
      gh.route('GET', `${repo}/collaborators/Codertocat`, { status: 404, body: { message: 'Not Found' } })
      gh.route('GET', `${repo}/labels`, repoLabels('lgtm'))
      gh.route('POST', `${repo}/issues/1/labels`, { status: 200, body: [] })
      gh.commitStatuses(repo, 'headsha', bound)
      gh.route('PUT', `${repo}/pulls/1/merge`, { status: 200, body: { merged: true } })

      const result = await runBundle({
        eventName: 'issue_comment',
        payload: prCommentEvent('/lgtm'),
        inputs: { ...token, 'prow-commands': '/lgtm' },
        apiUrl: gh.url,
      })

      expect(result.status, result.stdout).toBe(0)
      expect(result.errors).toEqual([])
      expect(result.stdout).toContain('merged pr #1')
      expect(gh.requestsMatching('POST', /\/issues\/1\/labels$/)[0].body).toEqual({ labels: ['lgtm'] })
      expect(gh.requestsMatching('POST', /\/statuses\/headsha$/)[0].body).toEqual({ state: 'success', context: 'prow/lgtm', description: 'lgtm by Codertocat at headsha', target_url: prCommentEvent('/lgtm').comment.html_url })
      expect(gh.requestsMatching('PUT', /./)[0].body).toEqual({ merge_method: 'squash', sha: 'headsha' })
      // the command authorizes, reads the configuration for the lgtm section, binds the head it already read, then labels;
      // the sweep then finds the configuration memoized (no needs-* rule: no label read), and tide reads the pr, its binding, and merges
      const calls = gh.requests.map(r => `${r.method} ${r.path}`)
      const post = calls.indexOf(`POST ${repo}/issues/1/labels`)
      const reads = configReads({ repo: '.github/prow.yaml' })
      expect(calls.slice(0, post - 2).sort()).toEqual([...ownersReads, `GET /orgs/Codertocat/members/Codertocat`, `GET ${repo}/collaborators/Codertocat`, ...reads].sort())
      expect(calls.slice(post - 2, post)).toEqual([`POST ${repo}/statuses/headsha`, labelsRead])
      expect(calls.slice(post + 1)).toEqual([pullRead, ownersProbe, `GET ${repo}/commits/headsha/status?per_page=100`, queueRead, merge])
    })

    it('issue_comment /kind cleanup on a pr carrying needs-kind: labels, then clears needs-kind in the same run', async () => {
      gh.route('GET', '/repos/Codertocat/.project/contents/prow.yaml', {
        status: 200,
        body: yamlFile('require_matching_label:\n  - regexp: ^kind/\n    missing_label: needs-kind\n'),
      })
      gh.route('GET', `${repo}/contents/.prowlabels.yaml`, { status: 200, body: labelFileContents })
      gh.route('GET', `${repo}/labels`, repoLabels('kind/cleanup', 'needs-kind'))
      gh.route('POST', `${repo}/issues/1/labels`, { status: 200, body: [] })
      gh.route('GET', `${repo}/issues/1`, { status: 200, body: { labels: [{ name: 'needs-kind' }, { name: 'kind/cleanup' }] } })
      gh.route('DELETE', `${repo}/issues/1/labels/needs-kind`, { status: 200, body: [] })
      gh.route('GET', `${repo}/pulls/1`, { status: 200, body: mergeablePr('clean', ['kind/cleanup']) })

      const result = await runBundle({
        eventName: 'issue_comment',
        payload: prCommentEvent('/kind cleanup'),
        inputs: { ...token, 'prow-commands': '/kind' },
        apiUrl: gh.url,
      })

      expect(result.status, result.stdout).toBe(0)
      expect(result.errors).toEqual([])
      expect(result.stdout).toContain('skipping pr #1: missing lgtm')
      expect(gh.requestsMatching('PUT', /./)).toEqual([])
      expectRequests([...configReads({ org: '.project', repo: '.prowlabels.yaml' }), labelsRead], [
        `POST ${repo}/issues/1/labels`,
        `GET ${repo}/issues/1`,
        `DELETE ${repo}/issues/1/labels/needs-kind`,
        pullRead,
        ownersProbe,
        queueRead,
      ])
    })

    it('pull_request labeled lgtm on a repository with OWNERS files: approved is required too, and the gate stops before the binding read', async () => {
      gh.commitStatuses(repo, head, bound)
      gh.route('GET', `${repo}/git/trees/master`, { status: 200, body: { sha: 'master', truncated: false, tree: [{ path: 'OWNERS', type: 'blob', sha: 'o' }] } })
      gh.route('GET', `${repo}/pulls/1`, { status: 200, body: mergeablePr('clean') })
      gh.route('PUT', `${repo}/pulls/1/merge`, { status: 200, body: { merged: true } })

      const result = await runPullRequest(labeledLgtm())

      expect(result.status, result.stdout).toBe(0)
      expect(result.errors).toEqual([])
      expect(result.stdout).toContain('skipping pr #1: missing approved')
      expect(gh.requestsMatching('PUT', /./)).toEqual([])
      expectRequests(configReads(), [bind, pullRead, ownersProbe, queueRead])
    })

    it('pull_request labeled lgtm: tide.merge_method wins over the input', async () => {
      gh.commitStatuses(repo, head, bound)
      gh.route('GET', `${repo}/contents/${encodeURIComponent('.github/prow.yaml')}`, { status: 200, body: yamlFile('tide:\n  merge_method: rebase\n') })
      gh.route('GET', `${repo}/pulls/1`, { status: 200, body: mergeablePr('clean') })
      gh.route('PUT', `${repo}/pulls/1/merge`, { status: 200, body: { merged: true } })

      const result = await runPullRequest(labeledLgtm())

      expect(result.status, result.stdout).toBe(0)
      expect(gh.requestsMatching('PUT', /./)[0].body).toEqual({ merge_method: 'rebase', sha: head })
      expectRequests(configReads({ repo: '.github/prow.yaml' }), [bind, pullRead, ownersProbe, bindingRead, queueRead, merge])
    })

    it('pull_request labeled lgtm with lgtm.bind_to_commit false: no status is written or read (legacy label-only merging)', async () => {
      gh.commitStatuses(repo, head, [])
      gh.route('GET', `${repo}/contents/${encodeURIComponent('.github/prow.yaml')}`, { status: 200, body: yamlFile('lgtm:\n  bind_to_commit: false\n') })
      gh.route('GET', `${repo}/pulls/1`, { status: 200, body: mergeablePr('clean') })
      gh.route('PUT', `${repo}/pulls/1/merge`, { status: 200, body: { merged: true } })

      const result = await runPullRequest(labeledLgtm())

      expect(result.status, result.stdout).toBe(0)
      expect(result.errors).toEqual([])
      expect(result.stdout).toContain('merged pr #1')
      expectRequests(configReads({ repo: '.github/prow.yaml' }), [pullRead, ownersProbe, queueRead, merge])
    })

    it.each(['blocked', 'behind', 'dirty', 'unstable'])('pull_request labeled lgtm: does not merge a %s pr', async (state) => {
      gh.commitStatuses(repo, head, bound)
      gh.route('GET', `${repo}/pulls/1`, { status: 200, body: mergeablePr(state) })
      gh.route('PUT', `${repo}/pulls/1/merge`, { status: 200, body: { merged: true } })

      const result = await runPullRequest(labeledLgtm())

      expect(result.status, result.stdout).toBe(0)
      expect(result.errors).toEqual([])
      expect(result.stdout).toContain(`skipping pr #1: not mergeable (${state})`)
      expect(gh.requestsMatching('PUT', /./)).toEqual([])
      expectRequests(configReads(), [bind, pullRead, ownersProbe, bindingRead, queueRead])
    })

    // GitHub answers unknown right after a push; the bundle really waits 1 s here before the second read
    it('pull_request labeled lgtm: re-reads an unknown state and merges once it is clean', async () => {
      gh.commitStatuses(repo, head, bound)
      gh.routeSequence('GET', `${repo}/pulls/1`, [
        { status: 200, body: mergeablePr('unknown') },
        { status: 200, body: mergeablePr('clean') },
      ])
      gh.route('PUT', `${repo}/pulls/1/merge`, { status: 200, body: { merged: true } })

      const result = await runPullRequest(labeledLgtm())

      expect(result.status, result.stdout).toBe(0)
      expect(result.errors).toEqual([])
      expectRequests(configReads(), [bind, pullRead, ownersProbe, bindingRead, queueRead, pullRead, merge])
    })

    it('pull_request labeled lgtm: a refused merge fails the run', async () => {
      gh.commitStatuses(repo, head, bound)
      gh.route('GET', `${repo}/pulls/1`, { status: 200, body: mergeablePr('clean') })
      gh.route('PUT', `${repo}/pulls/1/merge`, { status: 405, body: { message: 'Pull Request is not mergeable' } })

      const result = await runPullRequest(labeledLgtm())

      expect(result.status, result.stdout).toBe(1)
      expect(result.errors.some(e => e.includes('could not merge pr #1: Pull Request is not mergeable'))).toBe(true)
      expect(result.errors.some(e => e.includes('error handling pull_request event: could not merge pull request(s) #1'))).toBe(true)
      // the refusal triggers a re-read to tell a concurrent merge from a real failure
      expectRequests(configReads(), [bind, pullRead, ownersProbe, bindingRead, queueRead, merge, pullRead])
    })

    it('pull_request labeled lgtm: merge_on_events false binds the label and leaves the merge to the cron', async () => {
      gh.commitStatuses(repo, head, bound)
      gh.route('GET', `${repo}/contents/${encodeURIComponent('.github/prow.yaml')}`, { status: 200, body: yamlFile('tide:\n  merge_on_events: false\n') })
      gh.route('GET', `${repo}/pulls/1`, { status: 200, body: mergeablePr('clean') })

      const result = await runPullRequest(labeledLgtm())

      expect(result.status, result.stdout).toBe(0)
      expect(result.errors).toEqual([])
      expectRequests(configReads({ repo: '.github/prow.yaml' }), [bind])
    })

    describe('on a branch that requires a merge queue', () => {
      const graphql = 'POST /graphql'
      const nodeId = 'PR_kwDOtest'

      it('pull_request labeled lgtm: the pr is enqueued with expectedHeadOid = the bound head; no PUT merge', async () => {
        gh.commitStatuses(repo, head, bound)
        gh.route('GET', `${repo}/pulls/1`, { status: 200, body: mergeablePr('blocked') })
        gh.route('PUT', `${repo}/pulls/1/merge`, { status: 405, body: { message: 'Changes must be made through the merge queue.' } })
        gh.mergeQueue({ pullRequestId: nodeId, headOid: head, enabled: true })

        const result = await runPullRequest(labeledLgtm())

        expect(result.status, result.stdout).toBe(0)
        expect(result.errors).toEqual([])
        expect(result.stdout).toContain('enqueued pr #1 (position 1)')
        expect(gh.requestsMatching('PUT', /./)).toEqual([])
        const enqueues = gh.graphqlCalls('enqueuePullRequest')
        expect(enqueues).toHaveLength(1)
        expect((enqueues[0].body as { variables: unknown }).variables).toEqual({ pullRequestId: nodeId, expectedHeadOid: head })
        // the gate passes, so the state is read once, then the pull request's mergeability, then the enqueue
        expectRequests(configReads(), [bind, pullRead, ownersProbe, bindingRead, graphql, graphql])
      })

      it('tide.merge_queue: off never calls GraphQL and the 405 surfaces as before', async () => {
        gh.commitStatuses(repo, head, bound)
        gh.route('GET', `${repo}/contents/${encodeURIComponent('.github/prow.yaml')}`, { status: 200, body: yamlFile('tide:\n  merge_queue: off\n') })
        gh.route('GET', `${repo}/pulls/1`, { status: 200, body: mergeablePr('clean') })
        gh.route('PUT', `${repo}/pulls/1/merge`, { status: 405, body: { message: 'Changes must be made through the merge queue.' } })
        gh.mergeQueue({ pullRequestId: nodeId, headOid: head, enabled: true })

        const result = await runPullRequest(labeledLgtm())

        expect(result.status, result.stdout).toBe(1)
        expect(result.errors.some(e => e.includes('could not merge pr #1: Changes must be made through the merge queue.'))).toBe(true)
        expect(gh.requestsMatching('POST', /^\/graphql$/)).toEqual([])
        expectRequests(configReads({ repo: '.github/prow.yaml' }), [bind, pullRead, ownersProbe, bindingRead, merge, pullRead])
      })

      it('no queue on the base branch: one state read, then exactly the merge path of before', async () => {
        gh.commitStatuses(repo, head, bound)
        gh.route('GET', `${repo}/pulls/1`, { status: 200, body: mergeablePr('clean') })
        gh.route('PUT', `${repo}/pulls/1/merge`, { status: 200, body: { merged: true } })
        gh.mergeQueue({ pullRequestId: nodeId, headOid: head, enabled: false })

        const result = await runPullRequest(labeledLgtm())

        expect(result.status, result.stdout).toBe(0)
        expect(result.stdout).toContain('merged pr #1')
        expectRequests(configReads(), [bind, pullRead, ownersProbe, bindingRead, graphql, merge])
      })

      it('pull_request unlabeled lgtm on a pr the bot enqueued: dequeued', async () => {
        gh.route('GET', `${repo}/pulls/1`, { status: 200, body: mergeablePr('clean', []) })
        gh.mergeQueue({ pullRequestId: nodeId, headOid: head, enabled: true, inQueue: true, entry: { state: 'AWAITING_CHECKS', position: 1, enqueuer: 'github-actions' } })

        const result = await runBundle({ eventName: 'pull_request', payload: { ...pullReqOpenedEvent, action: 'unlabeled', label: { name: 'lgtm' } }, inputs: token, apiUrl: gh.url })

        expect(result.status, result.stdout).toBe(0)
        expect(result.stdout).toContain('dequeued pr #1: missing lgtm')
        expect(result.stdout).toContain('skipping pr #1: missing lgtm (dequeued)')
        const dequeues = gh.graphqlCalls('dequeuePullRequest')
        expect(dequeues).toHaveLength(1)
        expect((dequeues[0].body as { variables: unknown }).variables).toEqual({ id: nodeId })
        expectRequests(configReads(), [pullRead, ownersProbe, graphql, graphql])
      })

      it('pull_request unlabeled lgtm on a pr a human enqueued: left in the queue', async () => {
        gh.route('GET', `${repo}/pulls/1`, { status: 200, body: mergeablePr('clean', []) })
        gh.mergeQueue({ pullRequestId: nodeId, headOid: head, enabled: true, inQueue: true, entry: { state: 'QUEUED', position: 1, enqueuer: 'alice' } })

        const result = await runBundle({ eventName: 'pull_request', payload: { ...pullReqOpenedEvent, action: 'unlabeled', label: { name: 'lgtm' } }, inputs: token, apiUrl: gh.url })

        expect(result.status, result.stdout).toBe(0)
        expect(gh.graphqlCalls('dequeuePullRequest')).toEqual([])
        expectRequests(configReads(), [pullRead, ownersProbe, graphql])
      })

      it('schedule jobs: lgtm enqueues a queue-branch pr and never dequeues a gate-failing one', async () => {
        gh.route('GET', repo, { status: 200, body: { default_branch: 'master' } })
        gh.route('GET', new RegExp(`^${repo}/pulls\\?`), (req) => {
          const page = new URL(req.path, gh.url).searchParams.get('page')
          return { status: 200, body: page === '1' ? [mergeablePr('clean'), openPr(['kind/bug'], { number: 2 })] : [] }
        })
        gh.route('GET', `${repo}/pulls/1`, { status: 200, body: mergeablePr('clean') })
        gh.commitStatuses(repo, head, bound)
        gh.mergeQueue({ pullRequestId: nodeId, headOid: head, enabled: true })

        const result = await runBundle({ eventName: 'schedule', payload: {}, inputs: { ...token, jobs: 'lgtm' }, apiUrl: gh.url })

        expect(result.status, result.stdout).toBe(0)
        expect(result.errors).toEqual([])
        expect(result.stdout).toContain('enqueued pr #1 (position 1)')
        expect(result.stdout).toContain('skipping pr #2: missing lgtm')
        expect(gh.requestsMatching('PUT', /./)).toEqual([])
        expect(gh.requestsMatching('POST', /^\/graphql$/)).toHaveLength(2)
      })
    })

    it('pull_request_review submitted: evaluates the reviewed pr', async () => {
      gh.commitStatuses(repo, head, bound)
      gh.route('GET', `${repo}/pulls/1`, { status: 200, body: mergeablePr('clean') })
      gh.route('PUT', `${repo}/pulls/1/merge`, { status: 200, body: { merged: true } })

      const result = await runBundle({ eventName: 'pull_request_review', payload: pullReqReviewSubmittedEvent, inputs: token, apiUrl: gh.url })

      expect(result.status, result.stdout).toBe(0)
      expect(result.errors).toEqual([])
      expect(gh.requestsMatching('PUT', /./)[0].body).toEqual({ merge_method: 'merge', sha: head })
      // approve probes the tree first and finds no OWNERS files; tide reuses the answer
      expectRequests([ownersProbe, ...configReads()], [pullRead, bindingRead, queueRead, merge])
    })

    it('check_suite completed: evaluates the pull requests the payload names', async () => {
      gh.commitStatuses(repo, head, bound)
      gh.route('GET', `${repo}/pulls/1`, { status: 200, body: mergeablePr('clean') })
      gh.route('PUT', `${repo}/pulls/1/merge`, { status: 200, body: { merged: true } })

      const result = await runBundle({
        eventName: 'check_suite',
        payload: { ...checkSuiteCompletedEvent, check_suite: { ...checkSuiteCompletedEvent.check_suite, pull_requests: [{ number: 1 }] } },
        inputs: token,
        apiUrl: gh.url,
      })

      expect(result.status, result.stdout).toBe(0)
      expect(result.errors).toEqual([])
      expectRequests(configReads(), [pullRead, ownersProbe, bindingRead, queueRead, merge])
    })

    it('check_suite completed without pull_requests: finds the pr by head sha', async () => {
      const sha = checkSuiteCompletedEvent.check_suite.head_sha
      gh.commitStatuses(repo, sha, bound)
      gh.route('GET', new RegExp(`^${repo}/pulls\\?`), (req) => {
        const page = new URL(req.path, gh.url).searchParams.get('page')
        return { status: 200, body: page === '1' ? [{ number: 1, head: { sha } }, { number: 2, head: { sha: 'other' } }] : [] }
      })
      gh.route('GET', `${repo}/pulls/1`, { status: 200, body: { ...mergeablePr('clean'), head: { sha } } })
      gh.route('PUT', `${repo}/pulls/1/merge`, { status: 200, body: { merged: true } })

      const result = await runBundle({ eventName: 'check_suite', payload: checkSuiteCompletedEvent, inputs: token, apiUrl: gh.url })

      expect(result.status, result.stdout).toBe(0)
      expect(result.errors).toEqual([])
      expectRequests(configReads(), [
        `GET ${repo}/pulls?state=open&per_page=100&page=1`,
        `GET ${repo}/pulls?state=open&per_page=100&page=2`,
        pullRead,
        ownersProbe,
        `GET ${repo}/commits/${sha}/status?per_page=100`,
        queueRead,
        merge,
      ])
    })
  })

  describe('approve plugin on pull_request and pull_request_review events', () => {
    const ownersFiles: Record<string, string> = {
      'OWNERS': 'approvers:\n- alice\n',
      'sdk/OWNERS': 'approvers:\n- bob\n',
      'olm/OWNERS': 'options:\n  no_parent_owners: true\napprovers:\n- carol\n',
    }
    const marker = '<!-- prow-github-actions/approve -->'

    // the default branch has OWNERS files, so approve evaluates and the tide gate requires approved
    function routeOwnersRepo(files: string[], pulls: Record<string, unknown>[], comments: unknown[] = [], reviews: unknown[] = []) {
      gh.route('GET', `${repo}/git/trees/master`, { status: 200, body: { sha: 'master', truncated: false, tree: Object.keys(ownersFiles).map(path => ({ path, type: 'blob', sha: blobSha(path) })) } })
      // the first matching route wins, so the per-call pull bodies go in before routeOwners' static one
      gh.routeSequence('GET', `${repo}/pulls/1`, pulls.map(pull => ({ status: 200, body: { ...openPr([]), number: 1, base: { ref: 'master', sha: 'basesha' }, user: { login: 'Codertocat' }, draft: false, requested_reviewers: [], assignees: [], mergeable: true, mergeable_state: 'clean', ...pull } })))
      routeOwners(ownersFiles, files)
      gh.route('POST', `${repo}/pulls/1/requested_reviewers`, { status: 201, body: {} })
      gh.route('GET', `${repo}/issues/1/comments`, { status: 200, body: comments })
      gh.route('GET', `${repo}/pulls/1/reviews`, { status: 200, body: reviews })
      gh.route('GET', `${repo}/labels`, repoLabels('approved', 'lgtm'))
      gh.route('POST', `${repo}/issues/1/labels`, { status: 200, body: [] })
      gh.route('DELETE', `${repo}/issues/1/labels/approved`, { status: 200, body: [] })
      gh.route('POST', `${repo}/issues/1/comments`, { status: 201, body: {} })
      gh.route('PATCH', `${repo}/issues/comments/900`, { status: 200, body: {} })
      gh.route('PUT', `${repo}/pulls/1/merge`, { status: 200, body: { merged: true } })
      gh.commitStatuses(repo, pullReqListPulls[0].head.sha, [{ context: 'prow/lgtm', state: 'success' }])
    }

    // one evaluation of a pull request touching sdk/ only: the OWNERS reads, the two blobs on its path, comments and reviews
    const evaluationReads = [
      ...ownersReads,
      `GET ${repo}/git/blobs/${blobSha('OWNERS')}`,
      `GET ${repo}/git/blobs/${blobSha('sdk/OWNERS')}`,
      `GET ${repo}/issues/1/comments?per_page=100`,
      `GET ${repo}/pulls/1/reviews?per_page=100`,
    ]

    it('pull_request opened by the author of every changed file: approved is added, the notifier posted, tide skips opened', async () => {
      routeOwnersRepo(['sdk/x.go'], [{ user: { login: 'Bob' }, labels: [] }])

      const result = await runBundle({ eventName: 'pull_request', payload: pullReqOpenedEvent, inputs: token, apiUrl: gh.url })

      expect(result.status, result.stdout).toBe(0)
      expect(result.errors).toEqual([])
      expect(result.stdout).toContain('approve: #1 is approved by bob')
      expect(gh.requestsMatching('POST', /\/issues\/1\/labels$/).map(r => r.body)).toEqual([{ labels: ['approved'] }])
      const comments = gh.requestsMatching('POST', /\/issues\/1\/comments$/)
      expect(comments).toHaveLength(1)
      const body = (comments[0].body as { body: string }).body
      expect(body).toContain('[APPROVALNOTIFIER] This PR is **APPROVED**')
      expect(body).toContain('approved by: *bob*')
      expect(body.endsWith(marker)).toBe(true)
      expect(gh.requestsMatching('POST', /\/pulls\/1\/reviews$/)).toEqual([])
      expect(gh.requestsMatching('PUT', /./)).toEqual([])
      // require-matching-label's config probes come first (concurrent among themselves), then the OWNERS plugins share one
      // pull request read; approve runs after blunderbuss and before tide
      const calls = gh.requests.map(r => `${r.method} ${r.path}`)
      expect(calls.slice(0, configReads().length).sort()).toEqual(configReads().sort())
      expect(calls.slice(configReads().length, configReads().length + ownersReads.length)).toEqual(ownersReads)
      expect(calls.filter(call => call === `GET ${repo}/pulls/1`)).toHaveLength(1)
      expect(calls.slice(-7)).toEqual([
        `POST ${repo}/pulls/1/requested_reviewers`,
        ownersProbe,
        `GET ${repo}/issues/1/comments?per_page=100`,
        `GET ${repo}/pulls/1/reviews?per_page=100`,
        labelsRead,
        `POST ${repo}/issues/1/labels`,
        `POST ${repo}/issues/1/comments`,
      ])
    })

    it('pull_request_review APPROVED completing the coverage: approved is added, the notifier edited, tide merges', async () => {
      routeOwnersRepo(
        ['sdk/x.go', 'olm/y.go'],
        [{ user: { login: 'carol' }, labels: [{ name: 'lgtm' }] }, { user: { login: 'carol' }, labels: [{ name: 'lgtm' }, { name: 'approved' }] }],
        [{ id: 900, body: `stale\n${marker}`, user: { login: 'github-actions[bot]', type: 'Bot' }, created_at: '2024-01-01T00:00:00Z' }],
        [{ id: 1, state: 'APPROVED', user: { login: 'bob', type: 'User' }, submitted_at: '2024-01-01T00:00:01Z' }],
      )

      const result = await runBundle({ eventName: 'pull_request_review', payload: pullReqReviewSubmittedEvent, inputs: token, apiUrl: gh.url })

      expect(result.status, result.stdout).toBe(0)
      expect(result.errors).toEqual([])
      expect(result.stdout).toContain('approve: #1 is approved by bob, carol')
      expect(result.stdout).toContain('merged pr #1')
      expect(gh.requestsMatching('POST', /\/issues\/1\/labels$/).map(r => r.body)).toEqual([{ labels: ['approved'] }])
      expect(gh.requestsMatching('POST', /\/issues\/1\/comments$/)).toEqual([])
      const patches = gh.requestsMatching('PATCH', /\/issues\/comments\/900$/)
      expect(patches).toHaveLength(1)
      expect((patches[0].body as { body: string }).body).toContain('This PR is **APPROVED**')
      const calls = gh.requests.map(r => `${r.method} ${r.path}`)
      expect(calls.slice(-7)).toEqual([
        labelsRead,
        `POST ${repo}/issues/1/labels`,
        `PATCH ${repo}/issues/comments/900`,
        `GET ${repo}/pulls/1`,
        `GET ${repo}/commits/${pullReqListPulls[0].head.sha}/status?per_page=100`,
        queueRead,
        `PUT ${repo}/pulls/1/merge`,
      ])
      expect(gh.requestsMatching('GET', /\/git\/trees\/master/)).toHaveLength(1)
    })

    it('pull_request_review CHANGES_REQUESTED: approved is removed and tide skips the pr', async () => {
      routeOwnersRepo(
        ['sdk/x.go'],
        [{ user: { login: 'carol' }, labels: [{ name: 'lgtm' }, { name: 'approved' }] }, { user: { login: 'carol' }, labels: [{ name: 'lgtm' }] }],
        [
          { id: 900, body: `stale\n${marker}`, user: { login: 'github-actions[bot]', type: 'Bot' }, created_at: '2024-01-01T00:00:00Z' },
          { id: 901, body: '/approve', user: { login: 'bob', type: 'User' }, created_at: '2024-01-01T00:00:01Z' },
        ],
        [{ id: 1, state: 'CHANGES_REQUESTED', user: { login: 'bob', type: 'User' }, submitted_at: '2024-01-01T00:00:02Z' }],
      )

      const result = await runBundle({ eventName: 'pull_request_review', payload: pullReqReviewSubmittedEvent, inputs: token, apiUrl: gh.url })

      expect(result.status, result.stdout).toBe(0)
      expect(result.errors).toEqual([])
      expect(result.stdout).toContain('skipping pr #1: missing approved')
      expect(gh.requestsMatching('DELETE', /\/issues\/1\/labels\/approved$/)).toHaveLength(1)
      expect(gh.requestsMatching('PUT', /./)).toEqual([])
      expect((gh.requestsMatching('PATCH', /./)[0].body as { body: string }).body).toContain('This PR is **NOT APPROVED**')
      const calls = gh.requests.map(r => `${r.method} ${r.path}`)
      expect(evaluationReads.filter(read => !calls.includes(read))).toEqual([])
      expect(calls).not.toContain(`GET ${repo}/git/blobs/${blobSha('olm/OWNERS')}`)
    })

    it('pull_request_review on a repository without OWNERS files: only the tree probe and tide', async () => {
      gh.route('GET', `${repo}/pulls/1`, { status: 200, body: { ...openPr(['lgtm']), number: 1, mergeable: true, mergeable_state: 'clean' } })
      gh.route('PUT', `${repo}/pulls/1/merge`, { status: 200, body: { merged: true } })
      gh.commitStatuses(repo, pullReqListPulls[0].head.sha, [{ context: 'prow/lgtm', state: 'success' }])

      const result = await runBundle({ eventName: 'pull_request_review', payload: pullReqReviewSubmittedEvent, inputs: token, apiUrl: gh.url })

      expect(result.status, result.stdout).toBe(0)
      expect(result.errors).toEqual([])
      // approve probes the tree before tide reads the configuration
      expectRequests([ownersProbe, ...configReads()], [`GET ${repo}/pulls/1`, `GET ${repo}/commits/${pullReqListPulls[0].head.sha}/status?per_page=100`, queueRead, `PUT ${repo}/pulls/1/merge`])
    })
  })

  describe('schedule lgtm job', () => {
    // the gate's default follows each listed pull request's base branch, so the tree is probed once the page is listed
    const gateReads = [`GET ${repo}/pulls?state=open&page=1`, ownersProbe]
    const head = pullReqListPulls[0].head.sha
    // a listed pr that passes the gate is re-read through the shared merge path: its mergeability, then its lgtm binding
    const evaluation = [`GET ${repo}/pulls/2`, `GET ${repo}/commits/${head}/status?per_page=100`, queueRead]

    function routePulls(pr: Record<string, unknown>, merge: { status: number, body: unknown } = { status: 200, body: { merged: true } }, state = 'clean') {
      gh.route('GET', repo, { status: 200, body: { default_branch: 'master' } })
      gh.route('GET', new RegExp(`^${repo}/pulls\\?`), (req) => {
        const page = new URL(req.path, gh.url).searchParams.get('page')
        return { status: 200, body: page === '1' ? [pr] : [] }
      })
      gh.route('GET', `${repo}/pulls/2`, { status: 200, body: { ...pr, mergeable: true, mergeable_state: state } })
      gh.commitStatuses(repo, head, [{ context: 'prow/lgtm', state: 'success' }])
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

    // the cron reads the configuration once for the tide section, then pages through the pulls
    it('squash-merges an open lgtm pr', async () => {
      routePulls(openPr(['lgtm']))

      const result = await runCron()

      expect(result.status, result.stdout).toBe(0)
      expect(result.errors).toEqual([])
      const merges = gh.requestsMatching('PUT', /\/pulls\/2\/merge$/)
      expect(merges).toHaveLength(1)
      expect(merges[0].body).toEqual({ merge_method: 'squash', sha: head })
      expectRequests(configReads(), [
        ...gateReads,
        ...evaluation,
        `PUT ${repo}/pulls/2/merge`,
        `GET ${repo}/pulls?state=open&page=2`,
      ])
    })

    it('tide.merge_method in prow.yaml wins over the merge-method input', async () => {
      gh.route('GET', `${repo}/contents/${encodeURIComponent('.github/prow.yaml')}`, { status: 200, body: yamlFile('tide:\n  merge_method: rebase\n') })
      routePulls(openPr(['lgtm']))

      const result = await runCron()

      expect(result.status, result.stdout).toBe(0)
      expect(result.errors).toEqual([])
      const merges = gh.requestsMatching('PUT', /\/pulls\/2\/merge$/)
      expect(merges).toHaveLength(1)
      expect(merges[0].body).toEqual({ merge_method: 'rebase', sha: head })
      expectRequests(configReads({ repo: '.github/prow.yaml' }), [
        ...gateReads,
        ...evaluation,
        `PUT ${repo}/pulls/2/merge`,
        `GET ${repo}/pulls?state=open&page=2`,
      ])
    })

    it.each(['hold', 'do-not-merge/hold', 'do-not-merge/work-in-progress', 'needs-rebase'])('does not merge a pr that also has %s', async (label) => {
      routePulls(openPr(['lgtm', label]))

      const result = await runCron()

      expect(result.status, result.stdout).toBe(0)
      expect(result.errors).toEqual([])
      expect(result.stdout).toContain(`skipping pr #2: blocked by ${label}`)
      expect(gh.requestsMatching('PUT', /./)).toEqual([])
      expectRequests(configReads(), [
        ...gateReads,
        `GET ${repo}/pulls?state=open&page=2`,
      ])
    })

    it('does not merge a locked pr, without resolving its gate', async () => {
      routePulls(openPr(['lgtm'], { locked: true }))

      const result = await runCron()

      expect(result.status, result.stdout).toBe(0)
      expect(result.errors).toEqual([])
      expect(gh.requestsMatching('PUT', /./)).toEqual([])
      expectRequests(configReads(), [
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
      // the refusal triggers a re-read to tell a concurrent merge from a real failure
      expectRequests(configReads(), [
        ...gateReads,
        ...evaluation,
        `PUT ${repo}/pulls/2/merge`,
        `GET ${repo}/pulls/2`,
        `GET ${repo}/pulls?state=open&page=2`,
      ])
    })

    it.each(['blocked', 'unstable'])('skips a %s pr instead of sending a merge GitHub would refuse', async (state) => {
      routePulls(openPr(['lgtm']), undefined, state)

      const result = await runCron()

      expect(result.status, result.stdout).toBe(0)
      expect(result.errors).toEqual([])
      expect(result.stdout).toContain(`skipping pr #2: not mergeable (${state})`)
      expect(gh.requestsMatching('PUT', /./)).toEqual([])
    })
  })

  describe('schedule sweep job', () => {
    const listPage = (page: number) => `GET ${repo}/pulls?state=open&sort=updated&direction=desc&per_page=100&page=${page}`
    const bound = [{ context: 'prow/lgtm', state: 'success' }]

    function runSweep() {
      return runBundle({ eventName: 'schedule', payload: {}, inputs: { ...token, jobs: 'sweep' }, apiUrl: gh.url })
    }

    function forkPr(number: number, labels: string[], overrides: Record<string, unknown> = {}) {
      const stamp = new Date().toISOString()
      return openPr(labels, {
        number,
        created_at: stamp,
        updated_at: stamp,
        requested_reviewers: [],
        assignees: [],
        draft: false,
        mergeable: true,
        mergeable_state: 'clean',
        user: { login: 'dave' },
        head: { sha: `sha${number}`, repo: { full_name: 'dave/Hello-World' } },
        base: { ref: 'master', sha: 'basesha' },
        ...overrides,
      })
    }

    function routeList(prs: unknown[]) {
      gh.route('GET', repo, { status: 200, body: { default_branch: 'master' } })
      gh.route('GET', new RegExp(`^${repo}/pulls\\?`), (req) => {
        const page = new URL(req.path, gh.url).searchParams.get('page')
        return { status: 200, body: page === '1' ? prs : [] }
      })
    }

    it('on a repository without OWNERS files: a recently updated fork pr with a bound lgtm is merged, one updated long ago is not read', async () => {
      const fresh = forkPr(1, ['lgtm'])
      const old = forkPr(2, ['lgtm'], { updated_at: '2011-01-26T19:01:12Z' })
      routeList([fresh, old])
      gh.route('GET', `${repo}/pulls/1`, { status: 200, body: fresh })
      gh.commitStatuses(repo, 'sha1', bound)
      gh.route('PUT', `${repo}/pulls/1/merge`, { status: 200, body: { merged: true } })

      const result = await runSweep()

      expect(result.status, result.stdout).toBe(0)
      expect(result.errors).toEqual([])
      expect(result.stdout).toContain('sweep: 1 candidate updated since')
      expect(result.stdout).toContain('sweep: #1 merged')
      expect(gh.requestsMatching('PUT', /./)[0].body).toEqual({ merge_method: 'merge', sha: 'sha1' })
      // the configuration, the window's page, then per candidate: the OWNERS probe of its base branch (once per branch), the pr, its binding, the merge
      expectRequests(configReads(), [
        listPage(1),
        ownersProbe,
        `GET ${repo}/pulls/1`,
        `GET ${repo}/commits/sha1/status?per_page=100`,
        queueRead,
        `PUT ${repo}/pulls/1/merge`,
      ])
    })

    it('on a repository with OWNERS files: a new fork pr gets needs-kind, the OWNERS labels, reviewers and the approval notifier', async () => {
      const ownersFiles: Record<string, string> = { 'OWNERS': 'approvers:\n- alice\n', 'sdk/OWNERS': 'reviewers:\n- bob\n- carol\nlabels:\n- area/sdk\n' }
      gh.route('GET', '/repos/Codertocat/.project/contents/prow.yaml', {
        status: 200,
        body: yamlFile('require_matching_label:\n  - regexp: ^kind/\n    missing_label: needs-kind\n    prs: true\n'),
      })
      const pr = forkPr(1, [])
      routeList([pr])
      gh.route('GET', `${repo}/git/trees/master`, { status: 200, body: { sha: 'master', truncated: false, tree: Object.keys(ownersFiles).map(path => ({ path, type: 'blob', sha: blobSha(path) })) } })
      routeOwners(ownersFiles, ['sdk/x.go'], pr)
      gh.route('GET', `${repo}/issues/1`, { status: 200, body: { labels: [] } })
      gh.route('GET', `${repo}/labels`, repoLabels('needs-kind', 'area/sdk', 'approved', 'lgtm'))
      gh.route('POST', `${repo}/issues/1/labels`, { status: 200, body: [] })
      gh.route('GET', `${repo}/pulls/1/reviews`, { status: 200, body: [] })
      gh.route('POST', `${repo}/pulls/1/requested_reviewers`, { status: 201, body: {} })
      gh.route('GET', `${repo}/issues/1/comments`, { status: 200, body: [] })
      gh.route('POST', `${repo}/issues/1/comments`, { status: 201, body: {} })

      const result = await runSweep()

      expect(result.status, result.stdout).toBe(0)
      expect(result.errors).toEqual([])
      expect(result.stdout).toContain('sweep: #1 evaluated')
      expect(result.stdout).toContain('skipping pr #1: missing lgtm')
      expect(gh.requestsMatching('POST', /\/issues\/1\/labels$/).map(r => r.body)).toEqual([{ labels: ['needs-kind'] }, { labels: ['area/sdk'] }])
      const reviewers = gh.requestsMatching('POST', /requested_reviewers$/)
      expect(reviewers).toHaveLength(1)
      expect((reviewers[0].body as { reviewers: string[] }).reviewers).toHaveLength(2)
      const comments = gh.requestsMatching('POST', /\/issues\/1\/comments$/)
      expect(comments).toHaveLength(1)
      expect((comments[0].body as { body: string }).body).toContain('[APPROVALNOTIFIER] This PR is **NOT APPROVED**')
      expect(gh.requestsMatching('PUT', /./)).toEqual([])
    })

    it('one pull request failing does not stop the next; the run fails listing it', async () => {
      const one = forkPr(1, ['lgtm'])
      const two = forkPr(2, ['lgtm'])
      routeList([one, two])
      gh.route('GET', `${repo}/pulls/1`, { status: 200, body: one })
      gh.route('GET', `${repo}/pulls/2`, { status: 200, body: two })
      gh.commitStatuses(repo, 'sha1', bound)
      gh.commitStatuses(repo, 'sha2', bound)
      gh.route('PUT', `${repo}/pulls/1/merge`, { status: 405, body: { message: 'Pull Request is not mergeable' } })
      gh.route('PUT', `${repo}/pulls/2/merge`, { status: 200, body: { merged: true } })

      const result = await runSweep()

      expect(result.status, result.stdout).toBe(1)
      expect(result.errors.some(e => e.includes('sweep: 1 pull request(s) failed: #1 (tide: Pull Request is not mergeable)'))).toBe(true)
      expect(gh.requestsMatching('PUT', /\/pulls\/2\/merge$/)).toHaveLength(1)
    })
  })

  describe('workflow_dispatch label-sync job', () => {
    const orgConfig = yamlFile('labels:\n  kind:\n    - name: bug\n      color: d73a4a\n      description: Something is not working\n    - cleanup\n')
    const builtins = [
      'approved',
      'do-not-merge/hold',
      'good first issue',
      'help wanted',
      'hold',
      'lgtm',
      'lifecycle/frozen',
      'lifecycle/rotten',
      'lifecycle/stale',
      'ok-to-test',
      'stage/alpha',
      'stage/beta',
      'stage/stable',
      'status/approved-for-milestone',
      'status/in-progress',
      'status/in-review',
    ]

    it('creates the missing labels, recolors the drifted one and deletes nothing', async () => {
      gh.route('GET', '/repos/Codertocat/.project/contents/prow.yaml', { status: 200, body: orgConfig })
      gh.route('GET', `${repo}/labels`, { status: 200, body: [{ name: 'kind/bug', color: '000000', description: 'Something is not working' }, { name: 'unrelated', color: 'ffffff' }] })
      gh.route('POST', `${repo}/labels`, { status: 201, body: {} })
      gh.route('PATCH', new RegExp(`^${repo}/labels/`), { status: 200, body: {} })

      const result = await runBundle({
        eventName: 'workflow_dispatch',
        payload: {},
        inputs: { ...token, jobs: 'label-sync' },
        apiUrl: gh.url,
      })

      expect(result.status, result.stdout).toBe(0)
      expect(result.errors).toEqual([])
      const posts = gh.requestsMatching('POST', /\/labels$/)
      expect(posts.map(p => (p.body as { name: string }).name)).toEqual([...builtins, 'kind/cleanup'].sort((a, b) => a.localeCompare(b)))
      expect(posts.find(p => (p.body as { name: string }).name === 'lgtm')!.body).toEqual({
        name: 'lgtm',
        color: '15dd18',
        description: '"Looks good to me", indicates that a PR is ready to be merged.',
      })
      expect(posts.find(p => (p.body as { name: string }).name === 'kind/cleanup')!.body).toEqual({ name: 'kind/cleanup' })
      const patches = gh.requestsMatching('PATCH', /./)
      expect(patches).toHaveLength(1)
      expect(patches[0].path).toBe(`${repo}/labels/kind%2Fbug`)
      expect(patches[0].body).toEqual({ color: 'd73a4a' })
      expect(gh.requestsMatching('DELETE', /./)).toEqual([])
      const desired = [...builtins, 'kind/bug', 'kind/cleanup'].sort((a, b) => a.localeCompare(b))
      expectRequests(
        [...configReads({ org: '.project' }), labelsRead],
        desired.map(name => (name === 'kind/bug' ? `PATCH ${repo}/labels/kind%2Fbug` : `POST ${repo}/labels`)),
      )
    })
  })
})
