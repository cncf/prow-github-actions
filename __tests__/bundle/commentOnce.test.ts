import type { FakeGithub } from './fakeGithub'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import pullReqListPulls from '../fixtures/pullReq/pullReqListPulls.json'
import pullReqOpenedEvent from '../fixtures/pullReq/pullReqOpenedEvent.json'
import { start } from './fakeGithub'
import { configReads, helpersFor, ownersProbe, queueRead, repo, token } from './helpers'
import { runBundle } from './runBundle'

vi.setConfig({ testTimeout: 30_000 })

// the dedupe arm of src/utils/comments.ts createCommentOnce: when a bot comment on the pull request already
// carries the marker, the explanation is not posted again. bundle.test.ts routes every comment listing as `[]`,
// so it drives only the posting arm; these cases drive both callers (lgtmBinding's stale-lgtm strip and tide's
// fork-workflows diagnosis) with the marker already present, and with look-alikes that must not count
describe('dist/index.js createCommentOnce dedupe', () => {
  let gh: FakeGithub
  const { expectRequests } = helpersFor(() => gh)

  beforeAll(async () => {
    gh = await start()
  })
  beforeEach(() => gh.mergeQueueFallback({ pullRequestId: 'PR_none', headOid: pullReqOpenedEvent.pull_request.head.sha, enabled: false }))
  afterEach(() => gh.reset())
  afterAll(() => gh.close())

  const bot = { login: 'github-actions[bot]', type: 'Bot' }
  const human = { login: 'Codertocat', type: 'User' }

  function botComment(body: string, user: Record<string, string> = bot) {
    return { id: 700, body, user, created_at: '2024-01-01T00:00:00Z' }
  }

  function openPr(labels: string[], overrides: Record<string, unknown> = {}) {
    const pr = structuredClone(pullReqListPulls[0])
    return { ...pr, labels: labels.map(name => ({ name })), ...overrides }
  }

  describe('lgtmBinding stripStaleLgtm on pull_request labeled lgtm by a bot', () => {
    const head = pullReqOpenedEvent.pull_request.head.sha
    const short = head.slice(0, 7)
    const marker = `<!-- prow-github-actions/lgtm-stale: ${short} -->`
    const pullRead = `GET ${repo}/pulls/1`
    const bindingRead = `GET ${repo}/commits/${head}/status?per_page=100`
    const strip = [`DELETE ${repo}/issues/1/labels/lgtm`, `POST ${repo}/statuses/${head}`, `GET ${repo}/issues/1/comments?per_page=100`]

    function routeStrip(comments: unknown[]) {
      gh.route('GET', `${repo}/pulls/1`, { status: 200, body: openPr(['lgtm'], { number: 1, mergeable: true, mergeable_state: 'clean', head: { sha: head } }) })
      gh.route('DELETE', `${repo}/issues/1/labels/lgtm`, { status: 200, body: [] })
      gh.route('GET', `${repo}/issues/1/comments`, { status: 200, body: comments })
      gh.route('POST', `${repo}/issues/1/comments`, { status: 201, body: {} })
      gh.commitStatuses(repo, head, [])
    }

    function runLabeled() {
      return runBundle({
        eventName: 'pull_request',
        payload: { ...pullReqOpenedEvent, action: 'labeled', label: { name: 'lgtm' }, sender: { login: 'some-app[bot]', type: 'Bot' } },
        inputs: { ...token, 'merge-method': 'squash' },
        apiUrl: gh.url,
      })
    }

    it('a bot comment already carrying the marker: the label is still stripped, the explanation is not re-posted', async () => {
      routeStrip([botComment(`\`lgtm\` is not bound to the current head commit (\`${short}\`)\n\n${marker}`)])

      const result = await runLabeled()

      expect(result.status, result.stdout).toBe(0)
      expect(result.errors).toEqual([])
      expect(result.stdout).toContain(`skipping pr #1: lgtm not bound to ${short}`)
      expect(result.stdout).toContain(`::debug::#1 already carries ${marker}`)
      expect(gh.requestsMatching('DELETE', /\/labels\/lgtm$/)).toHaveLength(1)
      expect(gh.requestsMatching('POST', /\/issues\/1\/comments$/)).toEqual([])
      expect(gh.requestsMatching('PUT', /./)).toEqual([])
      expectRequests(configReads(), [pullRead, ownersProbe, bindingRead, ...strip, queueRead])
    })

    it.each([
      ['a human quoting the marker', () => botComment(`the bot said:\n${marker}`, human)],
      ['a bot marker for a different head', () => botComment(`stale\n\n<!-- prow-github-actions/lgtm-stale: 0000000 -->`)],
      ['a bot comment with no body', () => ({ id: 700, body: null, user: bot, created_at: '2024-01-01T00:00:00Z' })],
    ])('%s does not count: the explanation is posted', async (_name, existing) => {
      routeStrip([existing()])

      const result = await runLabeled()

      expect(result.status, result.stdout).toBe(0)
      expect(result.errors).toEqual([])
      expect(result.stdout).not.toContain('already carries')
      const comments = gh.requestsMatching('POST', /\/issues\/1\/comments$/)
      expect(comments).toHaveLength(1)
      expect((comments[0].body as { body: string }).body).toContain(marker)
      expectRequests(configReads(), [pullRead, ownersProbe, bindingRead, ...strip, `POST ${repo}/issues/1/comments`, queueRead])
    })
  })

  describe('tide explainForkWorkflows on the schedule lgtm job', () => {
    const head = pullReqListPulls[0].head.sha
    const marker = `<!-- prow-github-actions/fork-workflows: ${head.slice(0, 7)} -->`
    const diagnosis = [
      `PUT ${repo}/pulls/2/merge`,
      `GET ${repo}/pulls/2`,
      `GET ${repo}/compare/${head}...master`,
      `GET ${repo}/pulls/2/files?per_page=100`,
      `GET ${repo}/issues/2/comments?per_page=100`,
    ]

    function routeForkRefusal(comments: unknown[]) {
      const pr = openPr(['lgtm'], { head: { sha: head, repo: { full_name: 'dave/Hello-World' } } })
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
      gh.route('GET', `${repo}/issues/2/comments`, { status: 200, body: comments })
      gh.route('POST', `${repo}/issues/2/comments`, { status: 201, body: {} })
    }

    function runCron() {
      return runBundle({ eventName: 'schedule', payload: {}, inputs: { ...token, jobs: 'lgtm' }, apiUrl: gh.url })
    }

    it('a bot comment already carrying the marker: the pr is still skipped, the explanation is not re-posted', async () => {
      routeForkRefusal([botComment(`GitHub does not let the workflow token merge this pull request\n\n${marker}`)])

      const result = await runCron()

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
        ...diagnosis,
        `GET ${repo}/pulls?state=open&page=2`,
      ])
    })

    it('a human quoting the marker does not count: the explanation is posted', async () => {
      routeForkRefusal([botComment(`quoting: ${marker}`, human)])

      const result = await runCron()

      expect(result.status, result.stdout).toBe(0)
      expect(result.errors).toEqual([])
      expect(result.stdout).not.toContain('already carries')
      const comments = gh.requestsMatching('POST', /\/issues\/2\/comments$/)
      expect(comments).toHaveLength(1)
      expect((comments[0].body as { body: string }).body).toContain(marker)
    })
  })
})
