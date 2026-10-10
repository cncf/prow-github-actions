import type { FakeGithub } from './fakeGithub'
import { Buffer } from 'node:buffer'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import labelFileContents from '../fixtures/labels/labelFileContentsResp.json'
import pullReqOpenedEvent from '../fixtures/pullReq/pullReqOpenedEvent.json'
import { prCommentEvent } from '../utils/ownersData'
import { start } from './fakeGithub'
import { comment, configReads, helpersFor, membershipReads, ownersProbe, ownersReads, queueRead, repo, token } from './helpers'
import { runBundle } from './runBundle'

vi.setConfig({ testTimeout: 30_000 })

function yamlFile(text: string) {
  const file = structuredClone(labelFileContents)
  file.content = Buffer.from(text).toString('base64')
  return file
}

// the lgtm removal arms that unbind nothing, driven through dist/index.js: the pull_request `lgtm` job on a
// synchronize whose pull request carries no lgtm label (onPrLgtm.ts:33), and `/lgtm cancel` when there is no
// commit binding to void — on a pull request under `lgtm.bind_to_commit: false`, and on a plain issue (lgtm.ts:106)
describe('dist/index.js lgtm removal without a binding', () => {
  const head = pullReqOpenedEvent.pull_request.head.sha
  const labelsRead = `GET ${repo}/issues/1`
  const unlabel = `DELETE ${repo}/issues/1/labels/lgtm`
  let gh: FakeGithub
  const { calls, expectCommandThenConfig, routeOwners } = helpersFor(() => gh)

  beforeAll(async () => {
    gh = await start()
  })
  beforeEach(() => gh.mergeQueueFallback({ pullRequestId: 'PR_none', headOid: head, enabled: false }))
  afterEach(() => gh.reset())
  afterAll(() => gh.close())

  function routeMember(login: string) {
    gh.route('GET', `/orgs/Codertocat/members/${login}`, { status: 204 })
    gh.route('GET', `${repo}/collaborators/${login}`, { status: 404, body: { message: 'Not Found' } })
  }

  describe('pull_request synchronize with jobs: lgtm', () => {
    it('a pull request without the lgtm label: the labels are read and nothing is removed', async () => {
      routeOwners({}, ['src/file1.txt'])
      gh.route('GET', `${repo}/issues/1`, { status: 200, body: { labels: [{ name: 'kind/bug' }] } })

      const result = await runBundle({
        eventName: 'pull_request',
        payload: { ...pullReqOpenedEvent, action: 'synchronize' },
        inputs: { ...token, jobs: 'lgtm' },
        apiUrl: gh.url,
      })

      expect(result.status, result.stdout).toBe(0)
      expect(result.errors).toEqual([])
      expect(gh.requestsMatching('DELETE', /./)).toEqual([])
      // the registered handlers read the pull request and probe its base; the lgtm job then reads the labels
      expect(calls()).toEqual([...ownersReads, ownersProbe, labelsRead])
    })
  })

  describe('/lgtm cancel without a commit binding', () => {
    it('on a pull request under lgtm.bind_to_commit false: the label is removed and no status is written', async () => {
      // the pull request as tide re-reads it after the removal: no lgtm, so the post-command sweep merges nothing
      routeOwners({}, ['src/file1.txt'], { user: { login: 'some-author' }, labels: [] })
      routeMember('Codertocat')
      gh.route('GET', `${repo}/contents/${encodeURIComponent('.github/prow.yaml')}`, { status: 200, body: yamlFile('lgtm:\n  bind_to_commit: false\n') })
      gh.route('GET', `${repo}/issues/1`, { status: 200, body: { labels: [{ name: 'lgtm' }] } })
      gh.route('DELETE', `${repo}/issues/1/labels/lgtm`, { status: 200, body: [] })

      const result = await runBundle({
        eventName: 'issue_comment',
        payload: prCommentEvent('/lgtm cancel'),
        inputs: { ...token, 'prow-commands': '/lgtm' },
        apiUrl: gh.url,
      })

      expect(result.status, result.stdout).toBe(0)
      expect(result.errors).toEqual([])
      expect(gh.requestsMatching('POST', /\/statuses\//)).toEqual([])
      expect(gh.requestsMatching('DELETE', /./).map(r => r.path)).toEqual([`${repo}/issues/1/labels/lgtm`])
      // the reviewer is authorized and the pull request read, then the labels read and removal, the configuration
      // read that finds the binding off (so the head is never read for unbinding), and the post-command sweep
      const recorded = calls()
      const authReads = [...ownersReads, ...membershipReads('Codertocat')]
      expect(recorded.slice(0, authReads.length).sort()).toEqual([...authReads].sort())
      const afterAuth = recorded.slice(authReads.length)
      expect(afterAuth.slice(0, 2)).toEqual([labelsRead, unlabel])
      const reads = configReads({ repo: '.github/prow.yaml' })
      expect(afterAuth.slice(2, 2 + reads.length).sort()).toEqual([...reads].sort())
      expect(afterAuth.slice(2 + reads.length)).toEqual([`GET ${repo}/pulls/1`, ownersProbe, queueRead])
    })

    it('on an issue that is not a pull request: the label is removed and no pull request is read', async () => {
      routeMember('Codertocat')
      gh.route('GET', `${repo}/issues/1`, { status: 200, body: { labels: [{ name: 'lgtm' }] } })
      gh.route('DELETE', `${repo}/issues/1/labels/lgtm`, { status: 200, body: [] })

      const result = await runBundle({
        eventName: 'issue_comment',
        payload: comment('/lgtm cancel', 'some-author'),
        inputs: { ...token, 'prow-commands': '/lgtm' },
        apiUrl: gh.url,
      })

      expect(result.status, result.stdout).toBe(0)
      expect(result.errors).toEqual([])
      expect(gh.requestsMatching('POST', /./)).toEqual([])
      expect(gh.requestsMatching('GET', /\/pulls\//)).toEqual([])
      // issue-side authorization probes the root OWNERS file (none) and the commenter's membership; the removal
      // is the whole command, and only the post-command sweep's configuration reads follow — no tide calls on an issue
      expectCommandThenConfig([labelsRead, unlabel], [], [`GET ${repo}/contents/OWNERS`, ...membershipReads('Codertocat')])
    })
  })
})
