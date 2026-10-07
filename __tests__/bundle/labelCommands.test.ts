import type { FakeGithub } from './fakeGithub'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import labelFileContents from '../fixtures/labels/labelFileContentsResp.json'
import { start } from './fakeGithub'
import { comment, configReads, helpersFor, repo, repoLabels, token } from './helpers'
import { runBundle } from './runBundle'

vi.setConfig({ testTimeout: 30_000 })

const labelsRead = `GET ${repo}/labels?per_page=100`
const issueRead = `GET ${repo}/issues/1`

function issueLabels(...names: string[]) {
  return { status: 200, body: { labels: names.map(name => ({ name })) } }
}

function deleteRoute(label: string) {
  return `DELETE ${repo}/issues/1/labels/${encodeURIComponent(label)}`
}

// the label-command paths dist/index.js is not otherwise driven through: a fixed-label removal, a prefixed
// command served by Prow's built-in defaults, and the no-configuration failure docs/labeling.md promises
describe('dist/index.js fixed and built-in prefixed label commands', () => {
  let gh: FakeGithub
  const { expectRequests } = helpersFor(() => gh)

  beforeAll(async () => {
    gh = await start()
  })
  afterEach(() => gh.reset())
  afterAll(() => gh.close())

  function run(body: string, command: string) {
    return runBundle({ eventName: 'issue_comment', payload: comment(body), inputs: { ...token, 'prow-commands': command }, apiUrl: gh.url })
  }

  it('/remove-help removes help wanted and good first issue, matching label case-insensitively', async () => {
    gh.route('GET', `${repo}/issues/1`, issueLabels('Help Wanted', 'good first issue', 'kind/bug'))
    gh.route('DELETE', `${repo}/issues/1/labels/Help%20Wanted`, { status: 200, body: [] })
    gh.route('DELETE', `${repo}/issues/1/labels/good%20first%20issue`, { status: 200, body: [] })

    const result = await run('/remove-help', '/help')

    expect(result.status, result.stdout).toBe(0)
    expect(result.errors).toEqual([])
    expect(gh.requestsMatching('POST', /./)).toEqual([])
    // the gate reads the configuration for authorization.labels first; the needs-* re-check that follows finds it memoized
    expectRequests(configReads(), [issueRead, deleteRoute('Help Wanted'), deleteRoute('good first issue')])
  })

  // .prowlabels.yaml has no lifecycle key, so the command falls back to Prow's built-in values
  it('/lifecycle stale from the built-in defaults is exclusive: removes lifecycle/frozen, then adds lifecycle/stale', async () => {
    gh.route('GET', `${repo}/contents/.prowlabels.yaml`, { status: 200, body: labelFileContents })
    gh.route('GET', `${repo}/issues/1`, issueLabels('lifecycle/frozen', 'kind/bug'))
    gh.route('DELETE', `${repo}/issues/1/labels/lifecycle%2Ffrozen`, { status: 200, body: [] })
    gh.route('GET', `${repo}/labels`, repoLabels('lifecycle/frozen', 'lifecycle/stale', 'lifecycle/rotten'))
    gh.route('POST', `${repo}/issues/1/labels`, { status: 200, body: [] })

    const result = await run('/lifecycle stale', '/lifecycle')

    expect(result.status, result.stdout).toBe(0)
    expect(result.errors).toEqual([])
    expect(gh.requestsMatching('POST', /\/issues\/1\/labels$/).map(r => r.body)).toEqual([{ labels: ['lifecycle/stale'] }])
    expectRequests(configReads({ repo: '.prowlabels.yaml' }), [issueRead, deleteRoute('lifecycle/frozen'), labelsRead, `POST ${repo}/issues/1/labels`])
  })

  it('/lifecycle stale with no configuration file in any tier fails the run, as docs/labeling.md says it must', async () => {
    const result = await run('/lifecycle stale', '/lifecycle')

    expect(result.status, result.stdout).toBe(1)
    expect(result.errors.some(e => e.includes('no prow configuration found'))).toBe(true)
    expectRequests(configReads(), [])
  })
})
