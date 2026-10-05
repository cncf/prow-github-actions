import type { FakeGithub } from './fakeGithub'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import pullReqOpenedEvent from '../fixtures/pullReq/pullReqOpenedEvent.json'
import { prCommentEvent } from '../utils/ownersFixtures'
import { start } from './fakeGithub'
import { configReads, helpersFor, membershipReads, ownersProbe, ownersReads, queueRead, repo, token } from './helpers'
import { runBundle } from './runBundle'

vi.setConfig({ testTimeout: 30_000 })

// the failure arms of the lgtm-to-commit binding (src/plugins/lgtmBinding.ts) and of the /lgtm command
// (src/labels/lgtm.ts), driven through dist/index.js: a status write that fails for a reason other than a
// missing permission, a status read that fails, a stale-lgtm comment that fails, a labeled payload without
// a head, and the /lgtm cancel reads and writes that fail
describe('dist/index.js lgtm binding failure arms', () => {
  const head = pullReqOpenedEvent.pull_request.head.sha
  const short = head.slice(0, 7)
  const serverError = { status: 500, body: { message: 'boom' } }
  let gh: FakeGithub
  const { expectCommandThenConfig, expectRequests, routeOwners } = helpersFor(() => gh)

  beforeAll(async () => {
    gh = await start()
  })
  beforeEach(() => gh.mergeQueueFallback({ pullRequestId: 'PR_none', headOid: head, enabled: false }))
  afterEach(() => gh.reset())
  afterAll(() => gh.close())

  function comments() {
    return gh.requestsMatching('POST', /\/issues\/1\/comments$/).map(r => (r.body as { body: string }).body)
  }

  function routeMember(login: string) {
    gh.route('GET', `/orgs/Codertocat/members/${login}`, { status: 204 })
    gh.route('GET', `${repo}/collaborators/${login}`, { status: 404, body: { message: 'Not Found' } })
  }

  describe('/lgtm on a pull request', () => {
    const labelsRead = `GET ${repo}/issues/1`
    const unlabel = `DELETE ${repo}/issues/1/labels/lgtm`
    const bind = `POST ${repo}/statuses/headsha`
    const commentPost = `POST ${repo}/issues/1/comments`
    const authReads = [...ownersReads, ...membershipReads('Codertocat')]
    // the post-command sweep: tide reads the pr, probes its base for OWNERS files and asks for the merge queue state
    const sweep = [`GET ${repo}/pulls/1`, ownersProbe, queueRead]

    // the pull request (head `headsha`), its files and an OWNERS-less base tree: the reviewer is authorized by membership
    function routeLgtm() {
      routeOwners({}, ['src/file1.txt'], { user: { login: 'some-author' }, labels: [] })
      routeMember('Codertocat')
      gh.route('POST', `${repo}/issues/1/labels`, { status: 200, body: [] })
    }

    function runLgtm(body = '/lgtm', commenter?: string) {
      return runBundle({
        eventName: 'issue_comment',
        payload: prCommentEvent(body, commenter),
        inputs: { ...token, 'prow-commands': '/lgtm' },
        apiUrl: gh.url,
      })
    }

    it('when the status write fails for a reason other than a missing permission: refused with the error, no label applied', async () => {
      routeLgtm()
      gh.route('POST', `${repo}/statuses/headsha`, serverError)
      gh.route('POST', `${repo}/issues/1/comments`, { status: 201, body: {} })

      const result = await runLgtm()

      expect(result.status, result.stdout).toBe(1)
      expect(result.errors.some(e => e.includes(`could not bind lgtm to ${'headsha'.slice(0, 7)}: HttpError: boom`))).toBe(true)
      expect(result.errors.some(e => e.includes('grant `statuses: write`'))).toBe(false)
      expect(comments()).toEqual([`could not bind lgtm to ${'headsha'.slice(0, 7)}: HttpError: boom`])
      expect(gh.requestsMatching('POST', /\/issues\/1\/labels$/)).toEqual([])
      // authorized by membership, the configuration read for the binding setting, the (already read) head bound, the
      // refusal posted, then the post-command sweep still runs
      expectCommandThenConfig([], [bind, commentPost, ...sweep], authReads)
    })

    it('when the status write fails and the refusal comment cannot be posted: both errors are logged and the run still fails', async () => {
      routeLgtm()
      gh.route('POST', `${repo}/statuses/headsha`, serverError)
      gh.route('POST', `${repo}/issues/1/comments`, serverError)

      const result = await runLgtm()

      expect(result.status, result.stdout).toBe(1)
      expect(result.errors.some(e => e.includes(`could not bind lgtm to ${'headsha'.slice(0, 7)}: HttpError: boom`))).toBe(true)
      expect(result.errors.some(e => e.includes('Could not comment with an auth error: Error: could not add comment: HttpError: boom'))).toBe(true)
      expect(gh.requestsMatching('POST', /\/issues\/1\/labels$/)).toEqual([])
      expect(gh.requestsMatching('POST', /\/issues\/1\/comments$/)).toHaveLength(1)
    })

    it('/lgtm cancel when the labels read fails: the run fails naming the read, nothing is removed or unbound', async () => {
      routeLgtm()
      gh.route('GET', `${repo}/issues/1`, serverError)

      const result = await runLgtm('/lgtm cancel')

      expect(result.status, result.stdout).toBe(1)
      expect(result.errors.some(e => e.includes('could not remove latest review: could not get labels from issue: Error: could not get issue: HttpError: boom'))).toBe(true)
      expect(gh.requestsMatching('DELETE', /./)).toEqual([])
      expect(gh.requestsMatching('POST', /\/statuses\//)).toEqual([])
      // the failed labels read is the whole command; the sweep's configuration reads and tide calls follow
      expectCommandThenConfig([labelsRead], sweep, authReads)
    })

    it('/lgtm cancel when the label removal is refused: the run fails naming the removal, the head is not unbound', async () => {
      routeLgtm()
      gh.route('GET', `${repo}/issues/1`, { status: 200, body: { labels: [{ name: 'lgtm' }] } })
      gh.route('DELETE', `${repo}/issues/1/labels/lgtm`, serverError)

      const result = await runLgtm('/lgtm cancel')

      expect(result.status, result.stdout).toBe(1)
      expect(result.errors.some(e => e.includes('could not remove latest review: Error: could not remove label lgtm: HttpError: boom'))).toBe(true)
      expect(gh.requestsMatching('POST', /\/statuses\//)).toEqual([])
      expectCommandThenConfig([labelsRead, unlabel], sweep, authReads)
    })
  })

  describe('pull_request labeled lgtm', () => {
    const pullRead = `GET ${repo}/pulls/1`
    const bindingRead = `GET ${repo}/commits/${head}/status?per_page=100`

    function openPr(labels: string[]) {
      return {
        number: 1,
        state: 'open',
        draft: false,
        mergeable: true,
        mergeable_state: 'clean',
        labels: labels.map(name => ({ name })),
        head: { sha: head },
        base: { ref: 'master', sha: 'basesha' },
        user: { login: 'some-author' },
        html_url: pullReqOpenedEvent.pull_request.html_url,
        requested_reviewers: [],
        assignees: [],
      }
    }

    function labeledLgtm(sender: Record<string, unknown> = pullReqOpenedEvent.sender) {
      return { ...pullReqOpenedEvent, action: 'labeled', label: { name: 'lgtm' }, sender }
    }

    function runPullRequest(payload: unknown) {
      return runBundle({ eventName: 'pull_request', payload, inputs: { ...token, 'merge-method': 'squash' }, apiUrl: gh.url })
    }

    it('by a human when the binding status cannot be read: the run fails naming the read, nothing is merged or stripped', async () => {
      gh.route('POST', `${repo}/statuses/${head}`, { status: 201, body: {} })
      gh.route('GET', `${repo}/commits/${head}/status`, serverError)
      gh.route('GET', `${repo}/pulls/1`, { status: 200, body: openPr(['lgtm']) })

      const result = await runPullRequest(labeledLgtm())

      expect(result.status, result.stdout).toBe(1)
      expect(result.stdout).toContain(`lgtm: bound the hand-applied label on #1 to ${short}`)
      expect(result.errors.some(e => e.includes(`could not read the prow/lgtm status of ${short}: HttpError: boom`))).toBe(true)
      expect(result.errors.some(e => e.includes('grant `statuses: write`'))).toBe(false)
      expect(gh.requestsMatching('PUT', /./)).toEqual([])
      expect(gh.requestsMatching('DELETE', /./)).toEqual([])
    })

    it('by a human when the binding status read is forbidden: the failure names the permission to grant', async () => {
      gh.route('POST', `${repo}/statuses/${head}`, { status: 201, body: {} })
      gh.route('GET', `${repo}/commits/${head}/status`, { status: 403, body: { message: 'Resource not accessible by integration' } })
      gh.route('GET', `${repo}/pulls/1`, { status: 200, body: openPr(['lgtm']) })

      const result = await runPullRequest(labeledLgtm())

      expect(result.status, result.stdout).toBe(1)
      expect(result.errors.some(e => e.includes(`could not read the prow/lgtm status of ${short}: grant \`statuses: write\``))).toBe(true)
      expect(gh.requestsMatching('PUT', /./)).toEqual([])
    })

    it('by a bot (no binding) when the stale-lgtm comment cannot be read: the label is still stripped, the comment failure is a warning', async () => {
      gh.commitStatuses(repo, head, [])
      gh.route('GET', `${repo}/pulls/1`, { status: 200, body: openPr(['lgtm']) })
      gh.route('DELETE', `${repo}/issues/1/labels/lgtm`, { status: 200, body: [] })
      gh.route('GET', `${repo}/issues/1/comments`, serverError)

      const result = await runPullRequest(labeledLgtm({ login: 'some-app[bot]', type: 'Bot' }))

      expect(result.status, result.stdout).toBe(0)
      expect(result.errors).toEqual([])
      expect(result.stdout).toContain(`skipping pr #1: lgtm not bound to ${short}`)
      expect(result.stdout).toContain('could not comment on pr #1 about the stale lgtm: HttpError: boom')
      expect(gh.requestsMatching('DELETE', /\/labels\/lgtm$/)).toHaveLength(1)
      expect(gh.requestsMatching('POST', /\/statuses\//).map(r => r.body)).toEqual([
        { state: 'pending', context: 'prow/lgtm', description: `lgtm removed: not bound to ${short}` },
      ])
      expect(gh.requestsMatching('POST', /\/issues\/1\/comments$/)).toEqual([])
      expect(gh.requestsMatching('PUT', /./)).toEqual([])
      // the bot's label needs no binding, so the configuration is first read by tide's gate
      expectRequests(configReads(), [
        pullRead,
        ownersProbe,
        bindingRead,
        `DELETE ${repo}/issues/1/labels/lgtm`,
        `POST ${repo}/statuses/${head}`,
        `GET ${repo}/issues/1/comments?per_page=100`,
        queueRead,
      ])
    })

    it('by a human on a payload without a head commit: the run fails naming the missing head, writing no status', async () => {
      const { pull_request, ...rest } = labeledLgtm()
      const { head: _head, ...headless } = pull_request
      gh.route('GET', `${repo}/pulls/1`, { status: 200, body: openPr(['lgtm']) })

      const result = await runPullRequest({ ...rest, pull_request: headless })

      expect(result.status, result.stdout).toBe(1)
      expect(result.errors.some(e => e.includes('github context payload missing pull request head'))).toBe(true)
      expect(gh.requestsMatching('POST', /\/statuses\//)).toEqual([])
      expect(gh.requestsMatching('PUT', /./)).toEqual([])
    })
  })
})
