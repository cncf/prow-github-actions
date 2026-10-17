import type { FakeGithub } from './fakeGithub'
import { Buffer } from 'node:buffer'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import issuesLabeledEvent from '../fixtures/issues/issuesLabeledEvent.json'
import labelFileContents from '../fixtures/labels/labelFileContentsResp.json'
import pullReqOpenedEvent from '../fixtures/pullReq/pullReqOpenedEvent.json'
import { start } from './fakeGithub'
import { configReads, helpersFor, ownersProbe, ownersReads, queueRead, repo, token } from './helpers'
import { runBundle } from './runBundle'

vi.setConfig({ testTimeout: 30_000 })

// the REST schema types `issue-comment.body` and the object form of `issue.labels[].name` as optional;
// every other bundle scenario serves both fields, so the `?? ''` folds that stand in for them
// (comments.ts:58 in createCommentOnce, requireMatchingLabel.ts:248 in botCommentsWithMarker,
// trigger.ts:181 in okToTestOnPullRequest) are driven here, through dist/index.js
describe('dist/index.js optional REST fields served absent', () => {
  const head = pullReqOpenedEvent.pull_request.head.sha
  const short = head.slice(0, 7)
  const bot = { login: 'github-actions[bot]', type: 'Bot' }
  let gh: FakeGithub
  const { expectRequests, routeOwners } = helpersFor(() => gh)

  beforeAll(async () => {
    gh = await start()
  })
  beforeEach(() => gh.mergeQueueFallback({ pullRequestId: 'PR_none', headOid: head, enabled: false }))
  afterEach(() => gh.reset())
  afterAll(() => gh.close())

  it('synchronize skips a label object without a name and still approves the runs when another label is ok-to-test', async () => {
    routeOwners({}, ['src/file1.txt'])
    gh.route('GET', `${repo}/actions/runs`, { status: 200, body: { total_count: 1, workflow_runs: [
      { id: 9, name: 'CI', path: '.github/workflows/ci.yml', head_sha: head, status: 'action_required', conclusion: 'action_required' },
    ] } })
    gh.route('POST', `${repo}/actions/runs/9/approve`, { status: 201 })

    const result = await runBundle({
      eventName: 'pull_request',
      payload: { ...pullReqOpenedEvent, action: 'synchronize', pull_request: { ...pullReqOpenedEvent.pull_request, labels: [{ id: 2 }, { name: 'ok-to-test' }] } },
      inputs: token,
      apiUrl: gh.url,
    })

    expect(result.status, result.stdout).toBe(0)
    expect(result.errors).toEqual([])
    expect(result.stdout).toContain(`trigger: #1 approved 1 run(s) on ${short}`)
    expect(gh.requests.map(r => `${r.method} ${r.path}`)).toEqual([...ownersReads, ownersProbe, `GET ${repo}/actions/runs?head_sha=${head}&per_page=100`, `POST ${repo}/actions/runs/9/approve`])
  })

  it('synchronize with only a nameless label object does not carry ok-to-test and reads no runs', async () => {
    routeOwners({}, ['src/file1.txt'])

    const result = await runBundle({
      eventName: 'pull_request',
      payload: { ...pullReqOpenedEvent, action: 'synchronize', pull_request: { ...pullReqOpenedEvent.pull_request, labels: [{ id: 2 }] } },
      inputs: token,
      apiUrl: gh.url,
    })

    expect(result.status, result.stdout).toBe(0)
    expect(result.errors).toEqual([])
    expect(result.stdout).toContain('::debug::trigger: the pull request does not carry ok-to-test')
    expect(gh.requestsMatching('GET', /\/actions\/runs/)).toEqual([])
    expect(gh.requests.map(r => `${r.method} ${r.path}`)).toEqual([...ownersReads, ownersProbe])
  })

  it('stripping a stale lgtm posts the notice when the only bot comment on the pull request has no body', async () => {
    const staleMarker = `<!-- prow-github-actions/lgtm-stale: ${short} -->`
    gh.commitStatuses(repo, head, [])
    gh.route('GET', `${repo}/pulls/1`, { status: 200, body: {
      number: 1,
      state: 'open',
      draft: false,
      mergeable: true,
      mergeable_state: 'behind',
      labels: [{ name: 'lgtm' }],
      head: { sha: head },
      base: { ref: 'master', sha: 'basesha' },
      user: { login: 'some-author' },
      html_url: pullReqOpenedEvent.pull_request.html_url,
      requested_reviewers: [],
      assignees: [],
    } })
    gh.route('DELETE', `${repo}/issues/1/labels/lgtm`, { status: 200, body: [] })
    gh.route('GET', `${repo}/issues/1/comments`, { status: 200, body: [{ id: 11, user: bot }] })
    gh.route('POST', `${repo}/issues/1/comments`, { status: 201, body: {} })

    const result = await runBundle({
      eventName: 'pull_request',
      payload: { ...pullReqOpenedEvent, action: 'labeled', label: { name: 'lgtm' }, sender: { login: 'some-app[bot]', type: 'Bot' } },
      inputs: { ...token, 'merge-method': 'squash' },
      apiUrl: gh.url,
    })

    expect(result.status, result.stdout).toBe(0)
    expect(result.errors).toEqual([])
    expect(result.stdout).toContain(`skipping pr #1: lgtm not bound to ${short}`)
    expect(result.stdout).not.toContain(`#1 already carries ${staleMarker}`)
    const posted = gh.requestsMatching('POST', /\/issues\/1\/comments$/).map(r => (r.body as { body: string }).body)
    expect(posted).toHaveLength(1)
    expect(posted[0]).toContain(`\`lgtm\` is not bound to the current head commit (\`${short}\`)`)
    expect(posted[0]).toContain(staleMarker)
    expect(gh.requestsMatching('PUT', /./)).toEqual([])
    expectRequests(configReads(), [
      `GET ${repo}/pulls/1`,
      ownersProbe,
      `GET ${repo}/commits/${head}/status?per_page=100`,
      `DELETE ${repo}/issues/1/labels/lgtm`,
      `POST ${repo}/statuses/${head}`,
      `GET ${repo}/issues/1/comments?per_page=100`,
      `POST ${repo}/issues/1/comments`,
      queueRead,
    ])
  })

  it('labeled kind/bug deletes only the bot comment carrying the marker, leaving a bot comment without a body alone', async () => {
    const marker = '<!-- prow-github-actions/require-matching-label: needs-kind -->'
    const file = structuredClone(labelFileContents)
    file.content = Buffer.from('require_matching_label:\n  - regexp: ^kind/\n    missing_label: needs-kind\n    missing_comment: Please add a kind label.\n').toString('base64')
    gh.route('GET', '/repos/Codertocat/.project/contents/prow.yaml', { status: 200, body: file })
    gh.route('GET', `${repo}/issues/1`, { status: 200, body: { labels: [{ name: 'kind/bug' }, { name: 'needs-kind' }] } })
    gh.route('DELETE', `${repo}/issues/1/labels/needs-kind`, { status: 200, body: [] })
    gh.route('GET', `${repo}/issues/1/comments`, { status: 200, body: [
      { id: 11, user: bot },
      { id: 12, body: `Please add a kind label.\n\n${marker}`, user: bot },
    ] })
    gh.route('DELETE', `${repo}/issues/comments/12`, { status: 204 })

    const payload = structuredClone(issuesLabeledEvent)
    payload.action = 'labeled'
    payload.issue.labels = ['kind/bug', 'needs-kind'].map(name => ({ ...payload.label, name }))
    payload.label.name = 'kind/bug'

    const result = await runBundle({ eventName: 'issues', payload, inputs: token, apiUrl: gh.url })

    expect(result.status, result.stdout).toBe(0)
    expect(result.errors).toEqual([])
    expect(gh.requestsMatching('DELETE', /\/issues\/comments\//).map(r => r.path)).toEqual([`${repo}/issues/comments/12`])
    expectRequests(configReads({ org: '.project' }), [
      `GET ${repo}/issues/1`,
      `DELETE ${repo}/issues/1/labels/needs-kind`,
      `GET ${repo}/issues/1/comments?per_page=100`,
      `DELETE ${repo}/issues/comments/12`,
    ])
  })
})
