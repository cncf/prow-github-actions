import type { FakeGithub } from './fakeGithub'
import { Buffer } from 'node:buffer'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import labelFileContents from '../fixtures/labels/labelFileContentsResp.json'
import { start } from './fakeGithub'
import { comment, repo, repoLabels, token } from './helpers'
import { runBundle } from './runBundle'

vi.setConfig({ testTimeout: 30_000 })

// After a label-writing command the dispatcher sweeps the needs-* rules, since the bot's own
// label write fires no `labeled` event. When the same comment also carries
// /check-required-labels (and the workflow enables it), that command has just evaluated the
// rules, so the sweep must skip the second evaluation (handleIssueComment.ts:164,180)
describe('dist/index.js issue_comment sweep after /check-required-labels', () => {
  let gh: FakeGithub

  beforeAll(async () => {
    gh = await start()
  })
  afterEach(() => gh.reset())
  afterAll(() => gh.close())

  const issueRead = `GET ${repo}/issues/1`
  const needsKindComment = 'Please add a kind label.'

  function routeRuleAndHold() {
    const file = structuredClone(labelFileContents)
    file.content = Buffer.from(
      `require_matching_label:\n  - regexp: ^kind/\n    missing_label: needs-kind\n    missing_comment: ${needsKindComment}\n`,
    ).toString('base64')
    gh.route('GET', '/repos/Codertocat/.project/contents/prow.yaml', { status: 200, body: file })
    gh.route('GET', `${repo}/labels`, repoLabels('do-not-merge/hold', 'needs-kind'))
    gh.route('GET', `${repo}/issues/1`, { status: 200, body: { labels: [] } })
    gh.route('GET', `${repo}/issues/1/comments`, { status: 200, body: [] })
    gh.route('POST', `${repo}/issues/1/labels`, { status: 200, body: [] })
    gh.route('POST', `${repo}/issues/1/comments`, { status: 201, body: {} })
  }

  function labelPosts() {
    return gh.requestsMatching('POST', /\/issues\/1\/labels$/).map(r => r.body)
  }

  it('evaluates the rules once when the comment carries /hold and /check-required-labels', async () => {
    routeRuleAndHold()

    const result = await runBundle({
      eventName: 'issue_comment',
      payload: comment('/hold\n/check-required-labels'),
      inputs: { ...token, 'prow-commands': '/hold /check-required-labels' },
      apiUrl: gh.url,
    })

    expect(result.status, result.stdout).toBe(0)
    expect(result.errors).toEqual([])
    // the command read the issue; the sweep did not read it again
    expect(gh.requestsMatching('GET', /\/issues\/1$/)).toHaveLength(1)
    expect(labelPosts()).toEqual(expect.arrayContaining([{ labels: ['do-not-merge/hold'] }, { labels: ['needs-kind'] }]))
    expect(labelPosts()).toHaveLength(2)
    expect(gh.requestsMatching('POST', /\/issues\/1\/comments$/)).toHaveLength(1)
  })

  it('still sweeps the rules when /check-required-labels is enabled but absent from the comment', async () => {
    routeRuleAndHold()

    const result = await runBundle({
      eventName: 'issue_comment',
      payload: comment('/hold'),
      inputs: { ...token, 'prow-commands': '/hold /check-required-labels' },
      apiUrl: gh.url,
    })

    expect(result.status, result.stdout).toBe(0)
    expect(result.errors).toEqual([])
    // only the sweep read the issue, after the hold label was written
    expect(gh.requests.map(r => `${r.method} ${r.path}`).filter(call => call === issueRead || call.endsWith('/issues/1/labels')))
      .toEqual([`POST ${repo}/issues/1/labels`, issueRead, `POST ${repo}/issues/1/labels`])
    expect(labelPosts()).toEqual([{ labels: ['do-not-merge/hold'] }, { labels: ['needs-kind'] }])
    expect(gh.requestsMatching('POST', /\/issues\/1\/comments$/)).toHaveLength(1)
  })
})
