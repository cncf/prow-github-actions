import type { FakeGithub } from './fakeGithub'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import pullReqListPulls from '../fixtures/pullReq/pullReqListPulls.json'
import pullReqOpenedEvent from '../fixtures/pullReq/pullReqOpenedEvent.json'
import { start } from './fakeGithub'
import { configReads, helpersFor, ownersProbe, queueRead, repo, token } from './helpers'
import { runBundle } from './runBundle'

vi.setConfig({ testTimeout: 30_000 })

// createCommentOnce's "already carries the marker" arm, driven through dist/index.js by both of its callers:
// the stale-lgtm strip and tide's fork-workflows explanation. One explanation per fact, however many runs
// observe it — unless the marker was quoted by a human, which does not count.
describe('dist/index.js posts a marked explanation once', () => {
  let gh: FakeGithub
  const { expectRequests } = helpersFor(() => gh)

  beforeAll(async () => {
    gh = await start()
  })
  afterEach(() => gh.reset())
  afterAll(() => gh.close())

  const bot = { login: 'github-actions[bot]', type: 'Bot' }

  function existing(marker: string, user: { login: string, type: string } = bot) {
    return { id: 7, body: `an earlier explanation\n\n${marker}`, user }
  }

  describe('stale lgtm on pull_request labeled', () => {
    const head = pullReqOpenedEvent.pull_request.head.sha
    const short = head.slice(0, 7)
    const marker = `<!-- prow-github-actions/lgtm-stale: ${short} -->`
    const pullRead = `GET ${repo}/pulls/1`
    const bindingRead = `GET ${repo}/commits/${head}/status?per_page=100`
    const commentsRead = `GET ${repo}/issues/1/comments?per_page=100`
    const strip = [`DELETE ${repo}/issues/1/labels/lgtm`, `POST ${repo}/statuses/${head}`, commentsRead]

    function routeStrip(comments: unknown[]) {
      const pr = { ...structuredClone(pullReqListPulls[0]), number: 1, labels: [{ name: 'lgtm' }], mergeable: true, mergeable_state: 'clean', head: { sha: head } }
      gh.route('GET', `${repo}/pulls/1`, { status: 200, body: pr })
      gh.commitStatuses(repo, head, [])
      gh.route('DELETE', `${repo}/issues/1/labels/lgtm`, { status: 200, body: [] })
      gh.route('GET', `${repo}/issues/1/comments`, { status: 200, body: comments })
      gh.route('POST', `${repo}/issues/1/comments`, { status: 201, body: {} })
    }

    function run() {
      const payload = { ...pullReqOpenedEvent, action: 'labeled', label: { name: 'lgtm' }, sender: { login: 'some-app[bot]', type: 'Bot' } }
      return runBundle({ eventName: 'pull_request', payload, inputs: token, apiUrl: gh.url })
    }

    it('a bot comment already carrying the marker: the label is still stripped, no second comment is posted', async () => {
      routeStrip([existing(marker)])

      const result = await run()

      expect(result.status, result.stdout).toBe(0)
      expect(result.errors).toEqual([])
      expect(result.stdout).toContain(`::debug::#1 already carries ${marker}`)
      expect(gh.requestsMatching('DELETE', /\/labels\/lgtm$/)).toHaveLength(1)
      expect(gh.requestsMatching('POST', /\/statuses\//)[0].body).toEqual({ state: 'pending', context: 'prow/lgtm', description: `lgtm removed: not bound to ${short}` })
      expect(gh.requestsMatching('POST', /\/issues\/1\/comments$/)).toEqual([])
      expectRequests(configReads(), [pullRead, ownersProbe, bindingRead, ...strip, queueRead])
    })

    it('the marker quoted by a human, and a bot comment for another head: neither counts, the explanation is posted', async () => {
      routeStrip([
        existing(marker, { login: 'Codertocat', type: 'User' }),
        existing('<!-- prow-github-actions/lgtm-stale: 0000000 -->'),
      ])

      const result = await run()

      expect(result.status, result.stdout).toBe(0)
      expect(result.errors).toEqual([])
      expect(result.stdout).not.toContain('already carries')
      const posted = gh.requestsMatching('POST', /\/issues\/1\/comments$/)
      expect(posted).toHaveLength(1)
      expect((posted[0].body as { body: string }).body).toContain(marker)
      expectRequests(configReads(), [pullRead, ownersProbe, bindingRead, ...strip, `POST ${repo}/issues/1/comments`, queueRead])
    })
  })

  describe('fork workflow files on the lgtm cron', () => {
    const head = pullReqListPulls[0].head.sha
    const marker = `<!-- prow-github-actions/fork-workflows: ${head.slice(0, 7)} -->`

    it('the pr already carries the explanation for this head: skipped again without a second comment', async () => {
      const pr = { ...structuredClone(pullReqListPulls[0]), labels: [{ name: 'lgtm' }], head: { sha: head, repo: { full_name: 'dave/Hello-World' } } }
      gh.route('GET', repo, { status: 200, body: { default_branch: 'master' } })
      gh.route('GET', new RegExp(`^${repo}/pulls\\?`), (req) => {
        const page = new URL(req.path, gh.url).searchParams.get('page')
        return { status: 200, body: page === '1' ? [pr] : [] }
      })
      gh.route('GET', `${repo}/pulls/2`, { status: 200, body: { ...pr, mergeable: true, mergeable_state: 'clean' } })
      gh.commitStatuses(repo, head, [{ context: 'prow/lgtm', state: 'success' }])
      gh.route('PUT', `${repo}/pulls/2/merge`, { status: 403, body: { message: 'Resource not accessible by integration' } })
      gh.route('GET', `${repo}/compare/${head}...master`, { status: 200, body: { files: [{ filename: '.github/workflows/prow.yml', status: 'added' }] } })
      gh.route('GET', `${repo}/pulls/2/files`, { status: 200, body: [{ filename: 'README.md', status: 'modified' }] })
      gh.route('GET', `${repo}/issues/2/comments`, { status: 200, body: [existing(marker)] })
      gh.route('POST', `${repo}/issues/2/comments`, { status: 201, body: {} })

      const result = await runBundle({ eventName: 'schedule', payload: {}, inputs: { ...token, 'jobs': 'lgtm', 'merge-method': 'squash' }, apiUrl: gh.url })

      expect(result.status, result.stdout).toBe(0)
      expect(result.errors).toEqual([])
      expect(result.stdout).toContain('skipping pr #2: fork pull request with workflow changes: the token may not merge it')
      expect(result.stdout).toContain(`::debug::#2 already carries ${marker}`)
      expect(gh.requestsMatching('POST', /\/issues\/2\/comments$/)).toEqual([])
      expectRequests(configReads(), [
        `GET ${repo}/pulls?state=open&page=1`,
        ownersProbe,
        `GET ${repo}/pulls/2`,
        `GET ${repo}/commits/${head}/status?per_page=100`,
        queueRead,
        `PUT ${repo}/pulls/2/merge`,
        `GET ${repo}/pulls/2`,
        `GET ${repo}/compare/${head}...master`,
        `GET ${repo}/pulls/2/files?per_page=100`,
        `GET ${repo}/issues/2/comments?per_page=100`,
        `GET ${repo}/pulls?state=open&page=2`,
      ])
    })
  })
})
