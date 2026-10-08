import type { FakeGithub } from './fakeGithub'
import { Buffer } from 'node:buffer'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import issuesLabeledEvent from '../fixtures/issues/issuesLabeledEvent.json'
import labelFileContents from '../fixtures/labels/labelFileContentsResp.json'
import { start } from './fakeGithub'
import { comment, configReads, helpersFor, repo, token } from './helpers'
import { runBundle } from './runBundle'

vi.setConfig({ testTimeout: 30_000 })

const labelsRead = `GET ${repo}/labels?per_page=100`
const commentsRead = `GET ${repo}/issues/1/comments?per_page=100`
const needsKindComment = 'Please add a kind label.'
const marker = '<!-- prow-github-actions/require-matching-label: needs-kind -->'
const botComment = { id: 11, body: `${needsKindComment}\n\n${marker}`, user: { login: 'github-actions[bot]', type: 'Bot' } }

function yamlFile(text: string) {
  const file = structuredClone(labelFileContents)
  file.content = Buffer.from(text).toString('base64')
  return file
}

function issuesEvent(action: string, labels: string[], label?: string) {
  const payload = structuredClone(issuesLabeledEvent)
  payload.action = action
  payload.issue.labels = labels.map(name => ({ ...payload.label, name }))
  if (label !== undefined) {
    payload.label.name = label
  }
  return payload
}

// the require_matching_label arms bundle.test.ts does not reach: rules that do not apply, the
// already-correct verdict, the grace period, the closed-issue /check-required-labels, an already
// posted missing_comment, and the comment-read and comment-delete failures
describe('dist/index.js require-matching-label arms', () => {
  let gh: FakeGithub
  const { calls, expectRequests } = helpersFor(() => gh)

  beforeAll(async () => {
    gh = await start()
  })
  afterEach(() => gh.reset())
  afterAll(() => gh.close())

  function routeRule(rule: string) {
    gh.route('GET', '/repos/Codertocat/.project/contents/prow.yaml', {
      status: 200,
      body: yamlFile(`require_matching_label:\n  - regexp: ^kind/\n    missing_label: needs-kind\n${rule}`),
    })
    gh.route('GET', `${repo}/labels`, { status: 200, body: [{ name: 'needs-kind' }, { name: 'kind/bug' }] })
    gh.route('POST', `${repo}/issues/1/labels`, { status: 200, body: [] })
    gh.route('DELETE', `${repo}/issues/1/labels/needs-kind`, { status: 200, body: [] })
    gh.route('POST', `${repo}/issues/1/comments`, { status: 201, body: {} })
  }

  async function run(payload: Record<string, unknown>) {
    return runBundle({ eventName: 'issues', payload, inputs: token, apiUrl: gh.url })
  }

  it('labeled with a label no rule concerns reads nothing past the configuration', async () => {
    routeRule('')

    const result = await run(issuesEvent('labeled', ['area/sdk'], 'area/sdk'))

    expect(result.status, result.stdout).toBe(0)
    expect(result.errors).toEqual([])
    expectRequests(configReads({ org: '.project' }), [])
  })

  it('opened on an issue when the only rule is for pull requests reads nothing past the configuration', async () => {
    routeRule('    prs: true\n')

    const result = await run(issuesEvent('opened', []))

    expect(result.status, result.stdout).toBe(0)
    expect(result.errors).toEqual([])
    expectRequests(configReads({ org: '.project' }), [])
  })

  it('labeled kind/bug with no needs-kind present reads the labels and writes nothing', async () => {
    routeRule('')
    gh.route('GET', `${repo}/issues/1`, { status: 200, body: { labels: [{ name: 'kind/bug' }] } })

    const result = await run(issuesEvent('labeled', ['kind/bug'], 'kind/bug'))

    expect(result.status, result.stdout).toBe(0)
    expect(result.errors).toEqual([])
    expectRequests(configReads({ org: '.project' }), [`GET ${repo}/issues/1`])
  })

  it('opened with a grace_period_duration waits for it before reading the labels', async () => {
    routeRule('    grace_period_duration: 500ms\n')
    gh.route('GET', `${repo}/issues/1`, { status: 200, body: { labels: [] } })

    const started = Date.now()
    const result = await run(issuesEvent('opened', []))

    expect(result.status, result.stdout).toBe(0)
    expect(result.errors).toEqual([])
    expect(Date.now() - started).toBeGreaterThanOrEqual(450)
    expectRequests(configReads({ org: '.project' }), [
      `GET ${repo}/issues/1`,
      labelsRead,
      `POST ${repo}/issues/1/labels`,
    ])
    expect(gh.requestsMatching('POST', /\/issues\/1\/labels$/)[0].body).toEqual({ labels: ['needs-kind'] })
  })

  it('opened when the bot already posted the missing_comment adds the label and does not repeat the comment', async () => {
    routeRule(`    missing_comment: ${needsKindComment}\n`)
    gh.route('GET', `${repo}/issues/1`, { status: 200, body: { labels: [] } })
    gh.route('GET', `${repo}/issues/1/comments`, { status: 200, body: [botComment] })

    const result = await run(issuesEvent('opened', []))

    expect(result.status, result.stdout).toBe(0)
    expect(result.errors).toEqual([])
    expect(gh.requestsMatching('POST', /\/issues\/1\/comments$/)).toEqual([])
    expectRequests(configReads({ org: '.project' }), [
      `GET ${repo}/issues/1`,
      labelsRead,
      `POST ${repo}/issues/1/labels`,
      commentsRead,
    ])
  })

  it('opened when the comments cannot be listed adds the label, then fails the run naming the rule', async () => {
    routeRule(`    missing_comment: ${needsKindComment}\n`)
    gh.route('GET', `${repo}/issues/1`, { status: 200, body: { labels: [] } })
    gh.route('GET', `${repo}/issues/1/comments`, { status: 500, body: { message: 'Server Error' } })

    const result = await run(issuesEvent('opened', []))

    expect(result.status, result.stdout).toBe(1)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toMatch(/^error handling issues event: require-matching-label needs-kind: could not list comments: HttpError: Server Error/)
    expectRequests(configReads({ org: '.project' }), [
      `GET ${repo}/issues/1`,
      labelsRead,
      `POST ${repo}/issues/1/labels`,
      commentsRead,
    ])
  })

  it('labeled kind/bug when the bot comment cannot be deleted removes needs-kind, then fails the run naming the comment', async () => {
    routeRule(`    missing_comment: ${needsKindComment}\n`)
    gh.route('GET', `${repo}/issues/1`, { status: 200, body: { labels: [{ name: 'kind/bug' }, { name: 'needs-kind' }] } })
    gh.route('GET', `${repo}/issues/1/comments`, { status: 200, body: [botComment] })
    gh.route('DELETE', `${repo}/issues/comments/11`, { status: 500, body: { message: 'Server Error' } })

    const result = await run(issuesEvent('labeled', ['kind/bug', 'needs-kind'], 'kind/bug'))

    expect(result.status, result.stdout).toBe(1)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toMatch(/^error handling issues event: require-matching-label needs-kind: could not delete comment 11: HttpError: Server Error/)
    expectRequests(configReads({ org: '.project' }), [
      `GET ${repo}/issues/1`,
      `DELETE ${repo}/issues/1/labels/needs-kind`,
      commentsRead,
      `DELETE ${repo}/issues/comments/11`,
    ])
  })

  it('issue_comment /check-required-labels on a closed issue makes no request at all', async () => {
    const payload = comment('/check-required-labels')
    payload.issue.state = 'closed'

    const result = await runBundle({
      eventName: 'issue_comment',
      payload,
      inputs: { ...token, 'prow-commands': '/check-required-labels' },
      apiUrl: gh.url,
    })

    expect(result.status, result.stdout).toBe(0)
    expect(result.errors).toEqual([])
    expect(calls()).toEqual([])
  })
})
