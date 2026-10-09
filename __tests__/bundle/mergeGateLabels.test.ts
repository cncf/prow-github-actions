import type { FakeGithub } from './fakeGithub'
import { Buffer } from 'node:buffer'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import labelFileContents from '../fixtures/labels/labelFileContentsResp.json'
import pullReqListPulls from '../fixtures/pullReq/pullReqListPulls.json'
import pullReqOpenedEvent from '../fixtures/pullReq/pullReqOpenedEvent.json'
import { start } from './fakeGithub'
import { configReads, helpersFor, ownersProbe, queueRead, repo, token } from './helpers'
import { runBundle } from './runBundle'

vi.setConfig({ testTimeout: 30_000 })

// the merge gate's `missing_labels` arm, driven through dist/index.js: the default `do-not-merge/*`
// family, a configured list whose `*` wildcards sit at either end and in the middle of a pattern,
// and the documented rule that a configured list replaces the default one instead of extending it
describe('dist/index.js tide merge gate on missing_labels', () => {
  let gh: FakeGithub
  const { expectRequests } = helpersFor(() => gh)

  const head = pullReqOpenedEvent.pull_request.head.sha
  const bind = `POST ${repo}/statuses/${head}`
  const pullRead = `GET ${repo}/pulls/1`
  const labeledLgtm = { ...pullReqOpenedEvent, action: 'labeled', label: { name: 'lgtm' } }

  beforeAll(async () => {
    gh = await start()
  })
  beforeEach(() => gh.mergeQueueFallback({ pullRequestId: 'PR_none', headOid: head, enabled: false }))
  afterEach(() => gh.reset())
  afterAll(() => gh.close())

  function routeCleanPr(labels: string[]) {
    const pr = structuredClone(pullReqListPulls[0])
    gh.commitStatuses(repo, head, [{ context: 'prow/lgtm', state: 'success' }])
    gh.route('GET', `${repo}/pulls/1`, { status: 200, body: { ...pr, labels: labels.map(name => ({ name })), mergeable: true, mergeable_state: 'clean', head: { sha: head } } })
    gh.route('PUT', `${repo}/pulls/1/merge`, { status: 200, body: { merged: true } })
  }

  function routeTide(yaml: string) {
    const file = structuredClone(labelFileContents)
    file.content = Buffer.from(`tide:\n${yaml}`).toString('base64')
    gh.route('GET', `${repo}/contents/${encodeURIComponent('.github/prow.yaml')}`, { status: 200, body: file })
  }

  function run() {
    return runBundle({ eventName: 'pull_request', payload: labeledLgtm, inputs: { ...token, 'merge-method': 'squash' }, apiUrl: gh.url })
  }

  it('a configured pattern with wildcards at both ends and in the middle blocks the label it matches', async () => {
    // `*-wip` fails on the suffix and `*wip*` has to find its middle part between the empty anchors
    routeTide('  missing_labels: ["do-not-merge/*", "*-wip", "*wip*"]\n')
    routeCleanPr(['lgtm', 'wip-docs'])

    const result = await run()

    expect(result.status, result.stdout).toBe(0)
    expect(result.errors).toEqual([])
    expect(result.stdout).toContain('skipping pr #1: blocked by wip-docs')
    expect(gh.requestsMatching('PUT', /./)).toEqual([])
    expectRequests(configReads({ repo: '.github/prow.yaml' }), [bind, pullRead, ownersProbe, queueRead])
  })
})
