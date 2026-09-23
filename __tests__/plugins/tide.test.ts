import { Buffer } from 'node:buffer'
import * as core from '@actions/core'
import { http } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { fetchMergeability, tideOnCheckSuite, tideOnComment, tideOnPullRequest, tideOnReview, tryMergePullRequest, unknownRetryDelaysMs } from '../../src/plugins/tide'
import { resolveTide } from '../../src/utils/config'
import { newOctokit } from '../../src/utils/octokit'
import * as sleepModule from '../../src/utils/sleep'
import labelFileContents from '../fixtures/labels/labelFileContentsResp.json'
import checkSuiteCompletedEvent from '../fixtures/pullReq/checkSuiteCompletedEvent.json'
import pullReqOpenedEvent from '../fixtures/pullReq/pullReqOpenedEvent.json'
import reviewSubmittedEvent from '../fixtures/pullReq/pullReqReviewSubmittedEvent.json'
import * as utils from '../testUtils'
import { prCommentEvent } from '../utils/ownersFixtures'

const server = setupServer()
beforeAll(() =>
  server.listen({
    onUnhandledRequest: 'error',
  }),
)
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

const repo = `${utils.api}/repos/Codertocat/Hello-World`
const tide = resolveTide({ merge_method: 'squash' })

function pull(labels: string[], overrides: Record<string, unknown> = {}) {
  return {
    number: 1,
    state: 'open',
    locked: false,
    draft: false,
    merged: false,
    mergeable: true,
    mergeable_state: 'clean',
    labels: labels.map(name => ({ name })),
    base: { ref: 'master', sha: 'basesha' },
    head: { sha: 'headsha' },
    ...overrides,
  }
}

// serves GET /pulls/1 with one body per call, repeating the last one
function servePull(...bodies: Record<string, unknown>[]) {
  const gets: string[] = []
  server.use(
    http.get(`${repo}/pulls/1`, () => {
      const body = bodies[Math.min(gets.length, bodies.length - 1)]
      gets.push('get')
      return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }),
  )
  return gets
}

function observeMerge(status = 200, body: unknown = { merged: true }) {
  const observe = new utils.ObserveRequest()
  server.use(http.put(`${repo}/pulls/1/merge`, utils.mockResponse(status, body, observe)))
  return observe
}

let sleep: ReturnType<typeof vi.spyOn>
let octokit: ReturnType<typeof newOctokit>
let context: utils.MockContext

beforeEach(() => {
  utils.setupActionsEnv()
  // every head is bound unless a test says otherwise
  server.use(utils.lgtmStatus())
  sleep = vi.spyOn(sleepModule, 'sleep').mockResolvedValue(undefined)
  octokit = newOctokit('some-token')
  context = new utils.MockContext(pullReqOpenedEvent)
})

const unknown = { mergeable: null, mergeable_state: 'unknown' }

describe('fetchMergeability', () => {
  it('maps the pull request fields', async () => {
    servePull(pull(['lgtm', 'kind/bug'], { locked: true }))

    await expect(fetchMergeability(octokit, context, 1)).resolves.toEqual({
      state: 'clean',
      mergeable: true,
      labels: ['lgtm', 'kind/bug'],
      draft: false,
      locked: true,
      merged: false,
      state_open: true,
      sha: 'headsha',
      base: 'master',
      fork: false,
    })
    expect(sleep).not.toHaveBeenCalled()
  })

  it('re-reads an unknown state after 1, 2 and 4 seconds until it is computed', async () => {
    const gets = servePull(pull([], unknown), pull([], unknown), pull([], { mergeable_state: 'behind' }))

    await expect(fetchMergeability(octokit, context, 1)).resolves.toMatchObject({ state: 'behind', mergeable: true })
    expect(gets).toHaveLength(3)
    expect(sleep.mock.calls.map(call => call[0])).toEqual([1000, 2000])
  })

  it('gives up after the last wait and returns the unknown state', async () => {
    const gets = servePull(pull([], unknown))
    const info = vi.spyOn(core, 'info')

    await expect(fetchMergeability(octokit, context, 1)).resolves.toMatchObject({ state: 'unknown', mergeable: null })
    expect(gets).toHaveLength(unknownRetryDelaysMs.length + 1)
    expect(sleep.mock.calls.map(call => call[0])).toEqual(unknownRetryDelaysMs)
    expect(info).toHaveBeenCalledWith('mergeability of pr #1 is still unknown after 3 retries')
  })

  it('treats a null mergeable as unknown even when the state says otherwise', async () => {
    const gets = servePull(pull([], { mergeable: null, mergeable_state: 'clean' }), pull([]))

    await expect(fetchMergeability(octokit, context, 1)).resolves.toMatchObject({ mergeable: true })
    expect(gets).toHaveLength(2)
  })

  it('stops retrying when retryIf says the wait is pointless', async () => {
    const gets = servePull(pull([], unknown))

    await expect(fetchMergeability(octokit, context, 1, { retryIf: () => false })).resolves.toMatchObject({ state: 'unknown' })
    expect(gets).toHaveLength(1)
    expect(sleep).not.toHaveBeenCalled()
  })
})

describe('tryMergePullRequest', () => {
  it('merges a clean pr that passes the gate with the configured merge method', async () => {
    const gets = servePull(pull(['lgtm']))
    const merge = observeMerge()
    const info = vi.spyOn(core, 'info')

    await expect(tryMergePullRequest(octokit, context, 1, tide)).resolves.toBe('merged')
    await expect(merge.called()).resolves.toBe('called')
    expect(await merge.body()).toEqual({ merge_method: 'squash', sha: 'headsha' })
    expect(gets).toHaveLength(1)
    expect(info).toHaveBeenCalledWith('merged pr #1')
  })

  it('merges a has_hooks pr', async () => {
    servePull(pull(['lgtm'], { mergeable_state: 'has_hooks' }))
    const merge = observeMerge()

    await expect(tryMergePullRequest(octokit, context, 1, tide)).resolves.toBe('merged')
    await expect(merge.called()).resolves.toBe('called')
  })

  it('does not merge a blocked pr and logs the state', async () => {
    servePull(pull(['lgtm'], { mergeable_state: 'blocked' }))
    const merge = observeMerge()
    const info = vi.spyOn(core, 'info')

    await expect(tryMergePullRequest(octokit, context, 1, tide)).resolves.toBe('skipped')
    await expect(merge.notCalled()).resolves.toBe('not called')
    expect(info).toHaveBeenCalledWith('skipping pr #1: not mergeable (blocked)')
  })

  it.each(['dirty', 'behind', 'unstable', 'draft'])('does not merge a %s pr', async (state) => {
    const gets = servePull(pull(['lgtm'], { mergeable_state: state, draft: state === 'draft' }))
    const merge = observeMerge()
    const info = vi.spyOn(core, 'info')

    await expect(tryMergePullRequest(octokit, context, 1, tide)).resolves.toBe('skipped')
    await expect(merge.notCalled()).resolves.toBe('not called')
    expect(info).toHaveBeenCalledWith(`skipping pr #1: not mergeable (${state})`)
    expect(gets).toHaveLength(1)
    expect(sleep).not.toHaveBeenCalled()
  })

  it('waits for an unknown state when the gate passes, then merges', async () => {
    const gets = servePull(pull(['lgtm'], unknown), pull(['lgtm']))
    const merge = observeMerge()

    await expect(tryMergePullRequest(octokit, context, 1, tide)).resolves.toBe('merged')
    await expect(merge.called()).resolves.toBe('called')
    expect(gets).toHaveLength(2)
    expect(sleep).toHaveBeenCalledExactlyOnceWith(1000)
  })

  it('skips a pr whose state is still unknown after the retries', async () => {
    const gets = servePull(pull(['lgtm'], unknown))
    const merge = observeMerge()
    const info = vi.spyOn(core, 'info')

    await expect(tryMergePullRequest(octokit, context, 1, tide)).resolves.toBe('skipped')
    await expect(merge.notCalled()).resolves.toBe('not called')
    expect(gets).toHaveLength(4)
    expect(info).toHaveBeenCalledWith('skipping pr #1: not mergeable (unknown)')
  })

  it.each([
    [['kind/bug'], 'missing lgtm'],
    [['lgtm', 'do-not-merge/hold'], 'blocked by do-not-merge/hold'],
  ])('does not wait for an unknown state when the gate fails on %j', async (labels, reason) => {
    const gets = servePull(pull(labels, unknown))
    const merge = observeMerge()
    const info = vi.spyOn(core, 'info')

    await expect(tryMergePullRequest(octokit, context, 1, tide)).resolves.toBe('skipped')
    await expect(merge.notCalled()).resolves.toBe('not called')
    expect(gets).toHaveLength(1)
    expect(sleep).not.toHaveBeenCalled()
    expect(info).toHaveBeenCalledWith(`skipping pr #1: ${reason}`)
  })

  it.each([
    ['closed', { state: 'closed' }],
    ['already merged', { state: 'closed', merged: true }],
    ['locked', { locked: true }],
  ])('skips a %s pr without waiting', async (reason, overrides) => {
    const gets = servePull(pull(['lgtm'], { ...unknown, ...overrides }))
    const merge = observeMerge()
    const info = vi.spyOn(core, 'info')

    await expect(tryMergePullRequest(octokit, context, 1, tide)).resolves.toBe('skipped')
    await expect(merge.notCalled()).resolves.toBe('not called')
    expect(gets).toHaveLength(1)
    expect(sleep).not.toHaveBeenCalled()
    expect(info).toHaveBeenCalledWith(`skipping pr #1: ${reason}`)
  })

  it('treats a refused merge as skipped when a re-read shows the pr merged concurrently', async () => {
    const gets = servePull(pull(['lgtm']), pull(['lgtm'], { state: 'closed', merged: true }))
    const merge = observeMerge(405, { message: 'Pull Request is not mergeable' })
    const info = vi.spyOn(core, 'info')
    const error = vi.spyOn(core, 'error').mockImplementation(() => {})

    await expect(tryMergePullRequest(octokit, context, 1, tide)).resolves.toBe('skipped')
    await expect(merge.called()).resolves.toBe('called')
    expect(gets).toHaveLength(2)
    expect(info).toHaveBeenCalledWith('pr #1 was merged concurrently')
    expect(error).not.toHaveBeenCalled()
  })

  it('reports a refused merge as failed when the pr is still open', async () => {
    const gets = servePull(pull(['lgtm']))
    const merge = observeMerge(405, { message: 'Pull Request is not mergeable' })
    const error = vi.spyOn(core, 'error').mockImplementation(() => {})

    await expect(tryMergePullRequest(octokit, context, 1, tide)).resolves.toBe('failed')
    await expect(merge.called()).resolves.toBe('called')
    expect(gets).toHaveLength(2)
    expect(error).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('could not merge pr #1: Pull Request is not mergeable'))
  })

  it('reports a refused merge as failed when the re-read fails too', async () => {
    let calls = 0
    server.use(
      http.get(`${repo}/pulls/1`, () => {
        calls++
        return calls === 1
          ? new Response(JSON.stringify(pull(['lgtm'])), { status: 200, headers: { 'Content-Type': 'application/json' } })
          : new Response(JSON.stringify({ message: 'boom' }), { status: 500, headers: { 'Content-Type': 'application/json' } })
      }),
    )
    observeMerge(405, { message: 'Pull Request is not mergeable' })
    const error = vi.spyOn(core, 'error').mockImplementation(() => {})

    await expect(tryMergePullRequest(octokit, context, 1, tide)).resolves.toBe('failed')
    expect(calls).toBe(2)
    expect(error).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('Pull Request is not mergeable'))
  })

  describe('pins the merge to the verified head', () => {
    it('sends the head sha it verified with the merge', async () => {
      servePull(pull(['lgtm'], { head: { sha: 'abc1234def' } }))
      const merge = observeMerge()

      await expect(tryMergePullRequest(octokit, context, 1, tide)).resolves.toBe('merged')
      await expect(merge.called()).resolves.toBe('called')
      expect((await merge.body()).sha).toBe('abc1234def')
    })

    it('skips without merging when the head moved while waiting for the mergeability', async () => {
      const gets = servePull(pull(['lgtm'], unknown), pull(['lgtm'], { head: { sha: 'moved' } }))
      const merge = observeMerge()
      const info = vi.spyOn(core, 'info')

      await expect(tryMergePullRequest(octokit, context, 1, tide)).resolves.toBe('skipped')
      await expect(merge.notCalled()).resolves.toBe('not called')
      expect(gets).toHaveLength(2)
      expect(info).toHaveBeenCalledWith('skipping pr #1: head moved during evaluation')
    })

    it('a 409 for a moved head is skipped, not failed, after the re-read', async () => {
      const gets = servePull(pull(['lgtm']))
      const merge = observeMerge(409, { message: 'Head branch was modified. Review and try the merge again.' })
      const info = vi.spyOn(core, 'info')
      const error = vi.spyOn(core, 'error').mockImplementation(() => {})

      await expect(tryMergePullRequest(octokit, context, 1, tide)).resolves.toBe('skipped')
      await expect(merge.called()).resolves.toBe('called')
      expect(gets).toHaveLength(2)
      expect(info).toHaveBeenCalledWith('skipping pr #1: head moved')
      expect(error).not.toHaveBeenCalled()
    })

    it('a 409 for a moved base is skipped too, with its own reason', async () => {
      servePull(pull(['lgtm']))
      observeMerge(409, { message: 'Base branch was modified. Review and try the merge again.' })
      const info = vi.spyOn(core, 'info')
      const error = vi.spyOn(core, 'error').mockImplementation(() => {})

      await expect(tryMergePullRequest(octokit, context, 1, tide)).resolves.toBe('skipped')
      expect(info).toHaveBeenCalledWith('skipping pr #1: base branch moved')
      expect(error).not.toHaveBeenCalled()
    })

    it('a 409 whose re-read shows the pr merged is a concurrent merge', async () => {
      servePull(pull(['lgtm']), pull(['lgtm'], { state: 'closed', merged: true }))
      observeMerge(409, { message: 'Head branch was modified. Review and try the merge again.' })
      const info = vi.spyOn(core, 'info')

      await expect(tryMergePullRequest(octokit, context, 1, tide)).resolves.toBe('skipped')
      expect(info).toHaveBeenCalledWith('pr #1 was merged concurrently')
    })
  })

  describe('once per run', () => {
    it('the scheduled jobs evaluate a pull request once: the second call is skipped without a read', async () => {
      const gets = servePull(pull(['lgtm']))
      const merge = observeMerge()
      const info = vi.spyOn(core, 'info')

      await expect(tryMergePullRequest(octokit, context, 1, tide, undefined, { once: true })).resolves.toBe('merged')
      await expect(tryMergePullRequest(octokit, context, 1, tide, undefined, { once: true })).resolves.toBe('skipped')
      await expect(merge.called()).resolves.toBe('called')
      expect(gets).toHaveLength(1)
      expect(info).toHaveBeenCalledWith('skipping pr #1: already evaluated in this run')
    })

    it('event evaluations never dedupe: two in one run are two merges attempts', async () => {
      const gets = servePull(pull(['lgtm']))
      let merges = 0
      server.use(http.put(`${repo}/pulls/1/merge`, () => {
        merges++
        return new Response(JSON.stringify({ merged: true }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }))

      await expect(tryMergePullRequest(octokit, context, 1, tide)).resolves.toBe('merged')
      await expect(tryMergePullRequest(octokit, context, 1, tide)).resolves.toBe('merged')
      expect(merges).toBe(2)
      expect(gets).toHaveLength(2)
    })

    it('resetTideWarnings forgets the evaluated pull requests', async () => {
      servePull(pull(['lgtm']))
      observeMerge()

      await expect(tryMergePullRequest(octokit, context, 1, tide, undefined, { once: true })).resolves.toBe('merged')
      utils.setupActionsEnv()
      await expect(tryMergePullRequest(octokit, context, 1, tide, undefined, { once: true })).resolves.toBe('merged')
    })
  })

  // a GitHub App token, GITHUB_TOKEN included, may not merge a fork pull request when the merge involves
  // .github/workflows/* changes: the `workflows` permission it cannot have (bors-ng/bors-ng#806; cncf/automation#709)
  describe('a 403 on a fork pull request', () => {
    const forbidden = { message: 'Resource not accessible by integration' }
    const marker = '<!-- prow-github-actions/fork-workflows: headsha -->'
    const reason = 'skipping pr #1: fork pull request with workflow changes: the token may not merge it'
    const forkPull = (labels: string[] = ['lgtm']) => pull(labels, {
      head: { sha: 'headsha', repo: { full_name: 'dave/Hello-World' } },
      base: { ref: 'master', sha: 'basesha', repo: { full_name: 'Codertocat/Hello-World' } },
    })

    function serveDiff(behind: string[], own: string[], comments: unknown[] = []) {
      const observe = { compare: new utils.ObserveRequest(), files: new utils.ObserveRequest(), comment: new utils.ObserveRequest() }
      server.use(
        http.get(`${repo}/compare/headsha...master`, utils.mockResponse(200, { files: behind.map(filename => ({ filename, status: 'added' })) }, observe.compare)),
        http.get(`${repo}/pulls/1/files`, utils.mockResponse(200, own.map(filename => ({ filename, status: 'modified' })), observe.files)),
        http.get(`${repo}/issues/1/comments`, utils.mockResponse(200, comments)),
        http.post(`${repo}/issues/1/comments`, utils.mockResponse(201, {}, observe.comment)),
      )
      return observe
    }

    it('behind on workflow files: explains once with a comment and skips instead of failing', async () => {
      servePull(forkPull())
      observeMerge(403, forbidden)
      const diff = serveDiff(['.github/workflows/ci.yml', 'README.md', '.github/workflows/release.yml'], ['src/a.go'])
      const info = vi.spyOn(core, 'info')
      const warning = vi.spyOn(core, 'warning').mockImplementation(() => {})
      const error = vi.spyOn(core, 'error').mockImplementation(() => {})

      await expect(tryMergePullRequest(octokit, context, 1, tide)).resolves.toBe('skipped')

      await expect(diff.compare.called()).resolves.toBe('called')
      await expect(diff.comment.called()).resolves.toBe('called')
      const body = (await diff.comment.body()).body as string
      expect(body).toContain('GitHub does not let the workflow token merge this pull request: it comes from a fork and the merge involves workflow files (`.github/workflows/ci.yml`, `.github/workflows/release.yml`) that the branch does not contain.')
      expect(body).toContain('Rebase onto `master`')
      expect(body).toContain('`workflows` scope as the `token` secret')
      expect(body.endsWith(marker)).toBe(true)
      expect(info).toHaveBeenCalledWith(reason)
      expect(warning.mock.calls.filter(call => String(call[0]).includes('fork pull request whose merge involves workflow files'))).toHaveLength(1)
      expect(error).not.toHaveBeenCalled()
    })

    it('does not comment again on the same head', async () => {
      servePull(forkPull())
      observeMerge(403, forbidden)
      const diff = serveDiff(['.github/workflows/ci.yml'], [], [{ id: 5, body: `old\n${marker}`, user: { login: 'github-actions[bot]', type: 'Bot' } }])
      vi.spyOn(core, 'warning').mockImplementation(() => {})

      await expect(tryMergePullRequest(octokit, context, 1, tide)).resolves.toBe('skipped')
      await expect(diff.comment.notCalled()).resolves.toBe('not called')
    })

    it('a fork pull request that itself changes workflow files, listing at most five', async () => {
      servePull(forkPull())
      observeMerge(403, forbidden)
      const own = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map(name => `.github/workflows/${name}.yml`)
      const diff = serveDiff([], own)
      vi.spyOn(core, 'warning').mockImplementation(() => {})

      await expect(tryMergePullRequest(octokit, context, 1, tide)).resolves.toBe('skipped')
      const body = (await diff.comment.body()).body as string
      expect(body).toContain('workflow files (`.github/workflows/a.yml`, `.github/workflows/b.yml`, `.github/workflows/c.yml`, `.github/workflows/d.yml`, `.github/workflows/e.yml` and 2 more) that it changes.')
    })

    it('a same-repository pull request keeps the raw failure and never compares', async () => {
      servePull(pull(['lgtm'], { head: { sha: 'headsha', repo: { full_name: 'Codertocat/Hello-World' } }, base: { ref: 'master', sha: 'basesha', repo: { full_name: 'Codertocat/Hello-World' } } }))
      observeMerge(403, forbidden)
      const diff = serveDiff(['.github/workflows/ci.yml'], [])
      const error = vi.spyOn(core, 'error').mockImplementation(() => {})

      await expect(tryMergePullRequest(octokit, context, 1, tide)).resolves.toBe('failed')
      await expect(diff.compare.notCalled()).resolves.toBe('not called')
      await expect(diff.comment.notCalled()).resolves.toBe('not called')
      expect(error).toHaveBeenCalledWith(expect.stringContaining('Resource not accessible by integration'))
    })

    it('a fork 403 with no workflow file anywhere is still a failure', async () => {
      servePull(forkPull())
      observeMerge(403, forbidden)
      const diff = serveDiff(['README.md'], ['src/a.go'])
      const error = vi.spyOn(core, 'error').mockImplementation(() => {})

      await expect(tryMergePullRequest(octokit, context, 1, tide)).resolves.toBe('failed')
      await expect(diff.compare.called()).resolves.toBe('called')
      await expect(diff.comment.notCalled()).resolves.toBe('not called')
      expect(error).toHaveBeenCalledWith(expect.stringContaining('Resource not accessible by integration'))
    })
  })
})

describe('tryMergePullRequest binds lgtm to the head commit', () => {
  const sha = 'def0123456789abcdef0123456789abcdef01234'
  const marker = '<!-- prow-github-actions/lgtm-stale: def0123 -->'

  function observeStrip(comments: unknown[] = []) {
    const removeLabel = new utils.ObserveRequest()
    const pending = new utils.ObserveRequest()
    const comment = new utils.ObserveRequest()
    server.use(
      http.delete(`${repo}/issues/1/labels/lgtm`, utils.mockResponse(200, [], removeLabel)),
      http.post(`${repo}/statuses/${sha}`, utils.mockResponse(201, {}, pending)),
      http.get(`${repo}/issues/1/comments`, utils.mockResponse(200, comments)),
      http.post(`${repo}/issues/1/comments`, utils.mockResponse(201, {}, comment)),
    )
    return { removeLabel, pending, comment }
  }

  it('headline 1: a clean pr with lgtm but no prow/lgtm status on its head is stripped, not merged', async () => {
    const gets = servePull(pull(['lgtm'], { head: { sha } }))
    const statuses = new utils.ObserveRequest()
    server.use(http.get(`${repo}/commits/${sha}/status`, utils.mockResponse(200, { state: 'pending', statuses: [] }, statuses)))
    const merge = observeMerge()
    const { removeLabel, pending, comment } = observeStrip()
    const info = vi.spyOn(core, 'info')

    await expect(tryMergePullRequest(octokit, context, 1, tide)).resolves.toBe('skipped')
    await expect(merge.notCalled()).resolves.toBe('not called')
    await expect(statuses.called()).resolves.toBe('called')
    await expect(removeLabel.called()).resolves.toBe('called')
    await expect(pending.called()).resolves.toBe('called')
    expect(await pending.body()).toEqual({ state: 'pending', context: 'prow/lgtm', description: 'lgtm removed: not bound to def0123' })
    await expect(comment.called()).resolves.toBe('called')
    const body = (await comment.body()).body as string
    expect(body).toContain('`lgtm` is not bound to the current head commit (`def0123`)')
    expect(body).toContain('Re-apply with `/lgtm` once the current commits are reviewed.')
    expect(body).toContain(marker)
    expect(info).toHaveBeenCalledWith('skipping pr #1: lgtm not bound to def0123')
    expect(gets).toHaveLength(1)
  })

  it('headline 1, second evaluation: the label is gone, so no statuses read and no second comment', async () => {
    servePull(pull([], { head: { sha } }))
    const statuses = new utils.ObserveRequest()
    server.use(http.get(`${repo}/commits/${sha}/status`, utils.mockResponse(200, { state: 'pending', statuses: [] }, statuses)))
    const merge = observeMerge()
    const { comment } = observeStrip()

    await expect(tryMergePullRequest(octokit, context, 1, tide)).resolves.toBe('skipped')
    await expect(merge.notCalled()).resolves.toBe('not called')
    await expect(statuses.notCalled()).resolves.toBe('not called')
    await expect(comment.notCalled()).resolves.toBe('not called')
  })

  it('does not comment twice on the same head', async () => {
    servePull(pull(['lgtm'], { head: { sha } }))
    server.use(http.get(`${repo}/commits/${sha}/status`, utils.mockResponse(200, { state: 'pending', statuses: [] })))
    observeMerge()
    const { removeLabel, comment } = observeStrip([{ id: 7, body: `stale\n\n${marker}`, user: { login: 'github-actions[bot]', type: 'Bot' } }])

    await expect(tryMergePullRequest(octokit, context, 1, tide)).resolves.toBe('skipped')
    await expect(removeLabel.called()).resolves.toBe('called')
    await expect(comment.notCalled()).resolves.toBe('not called')
  })

  it('headline 2: the same pr with prow/lgtm success on its head merges', async () => {
    const gets = servePull(pull(['lgtm'], { head: { sha } }))
    const statuses = new utils.ObserveRequest()
    server.use(http.get(`${repo}/commits/${sha}/status`, utils.mockResponse(200, {
      state: 'success',
      statuses: [{ context: 'ci/lint', state: 'success' }, { context: 'prow/lgtm', state: 'success', description: 'lgtm by alice at def0123' }],
    }, statuses)))
    const merge = observeMerge()
    const { removeLabel } = observeStrip()

    await expect(tryMergePullRequest(octokit, context, 1, tide)).resolves.toBe('merged')
    await expect(merge.called()).resolves.toBe('called')
    await expect(statuses.called()).resolves.toBe('called')
    await expect(removeLabel.notCalled()).resolves.toBe('not called')
    expect(gets).toHaveLength(1)
  })

  it('a pending prow/lgtm (cancelled or stale) on the head counts as unbound', async () => {
    servePull(pull(['lgtm'], { head: { sha } }))
    server.use(http.get(`${repo}/commits/${sha}/status`, utils.mockResponse(200, { state: 'pending', statuses: [{ context: 'prow/lgtm', state: 'pending' }] })))
    const merge = observeMerge()
    const { removeLabel } = observeStrip()

    await expect(tryMergePullRequest(octokit, context, 1, tide)).resolves.toBe('skipped')
    await expect(merge.notCalled()).resolves.toBe('not called')
    await expect(removeLabel.called()).resolves.toBe('called')
  })

  it('checks the binding only once the label gate passes', async () => {
    servePull(pull(['lgtm', 'do-not-merge/hold'], { head: { sha } }))
    const statuses = new utils.ObserveRequest()
    server.use(http.get(`${repo}/commits/${sha}/status`, utils.mockResponse(200, { state: 'pending', statuses: [] }, statuses)))
    observeMerge()

    await expect(tryMergePullRequest(octokit, context, 1, tide)).resolves.toBe('skipped')
    await expect(statuses.notCalled()).resolves.toBe('not called')
  })

  it('checks the binding before waiting for an unknown mergeability', async () => {
    const gets = servePull(pull(['lgtm'], { head: { sha }, ...unknown }))
    server.use(http.get(`${repo}/commits/${sha}/status`, utils.mockResponse(200, { state: 'pending', statuses: [] })))
    observeMerge()
    const { removeLabel } = observeStrip()

    await expect(tryMergePullRequest(octokit, context, 1, tide)).resolves.toBe('skipped')
    await expect(removeLabel.called()).resolves.toBe('called')
    expect(gets).toHaveLength(1)
    expect(sleep).not.toHaveBeenCalled()
  })

  it('bind_to_commit: false restores label-only merging without a statuses read', async () => {
    servePull(pull(['lgtm'], { head: { sha } }))
    const statuses = new utils.ObserveRequest()
    server.use(http.get(`${repo}/commits/${sha}/status`, utils.mockResponse(200, { state: 'pending', statuses: [] }, statuses)))
    const merge = observeMerge()

    await expect(tryMergePullRequest(octokit, context, 1, tide, { bind_to_commit: false })).resolves.toBe('merged')
    await expect(merge.called()).resolves.toBe('called')
    await expect(statuses.notCalled()).resolves.toBe('not called')
  })

  it('a refused statuses read fails with a hint at the missing permission', async () => {
    servePull(pull(['lgtm'], { head: { sha } }))
    server.use(http.get(`${repo}/commits/${sha}/status`, utils.mockResponse(403, { message: 'Resource not accessible by integration' })))
    const merge = observeMerge()

    await expect(tryMergePullRequest(octokit, context, 1, tide)).rejects.toThrow('could not read the prow/lgtm status of def0123: grant `statuses: write` to the workflow (or set `lgtm.bind_to_commit: false`)')
    await expect(merge.notCalled()).resolves.toBe('not called')
  })

  it('a refused pending status or comment is a warning; the label removal is what matters', async () => {
    servePull(pull(['lgtm'], { head: { sha } }))
    server.use(
      // the stale strip breaks the gate on an event, so tide asks the queue whether it holds the pr
      http.post(`${utils.api}/graphql`, utils.mockResponse(200, { data: { repository: { pullRequest: { id: 'PR_1', headRefOid: sha, isMergeQueueEnabled: false, isInMergeQueue: false, mergeQueueEntry: null } } } })),
      http.get(`${repo}/commits/${sha}/status`, utils.mockResponse(200, { state: 'pending', statuses: [] })),
      http.delete(`${repo}/issues/1/labels/lgtm`, utils.mockResponse(200, [])),
      http.post(`${repo}/statuses/${sha}`, utils.mockResponse(403, { message: 'Resource not accessible by integration' })),
      http.get(`${repo}/issues/1/comments`, utils.mockResponse(500, { message: 'boom' })),
    )
    observeMerge()
    const warning = vi.spyOn(core, 'warning').mockImplementation(() => {})

    await expect(tryMergePullRequest(octokit, context, 1, tide)).resolves.toBe('skipped')
    expect(warning).toHaveBeenCalledTimes(2)
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('could not set the prow/lgtm status of def0123 to pending'))
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('could not comment on pr #1'))
  })

  it('a refused label removal fails the evaluation', async () => {
    servePull(pull(['lgtm'], { head: { sha } }))
    server.use(
      http.get(`${repo}/commits/${sha}/status`, utils.mockResponse(200, { state: 'pending', statuses: [] })),
      http.delete(`${repo}/issues/1/labels/lgtm`, utils.mockResponse(500, { message: 'boom' })),
    )
    observeMerge()

    await expect(tryMergePullRequest(octokit, context, 1, tide)).rejects.toThrow('could not remove label lgtm')
  })
})

function prowYaml(text: string) {
  const file = structuredClone(labelFileContents)
  file.content = Buffer.from(text).toString('base64')
  return http.get(utils.contentsUrl('.github/prow.yaml'), utils.mockResponse(200, file))
}

function prEvent(action: string, extra: Record<string, unknown> = {}) {
  return new utils.MockContext({ ...pullReqOpenedEvent, action, ...extra })
}

describe('tideOnPullRequest', () => {
  beforeEach(() => {
    server.use(...utils.noOrgOrRepoConfigExcept(), utils.defaultBranchTree())
  })

  it('labeled lgtm: merges a clean pr', async () => {
    servePull(pull(['lgtm']))
    const merge = observeMerge()

    await expect(tideOnPullRequest(prEvent('labeled', { label: { name: 'lgtm' } }))).resolves.toBeUndefined()
    await expect(merge.called()).resolves.toBe('called')
    expect(await merge.body()).toEqual({ merge_method: 'merge', sha: 'headsha' })
  })

  it('labeled kind/bug on a pr without lgtm: one read, no merge', async () => {
    const gets = servePull(pull(['kind/bug']))
    const merge = observeMerge()

    await expect(tideOnPullRequest(prEvent('labeled', { label: { name: 'kind/bug' } }))).resolves.toBeUndefined()
    await expect(merge.notCalled()).resolves.toBe('not called')
    expect(gets).toHaveLength(1)
  })

  it('reads the labels from the api, not from the payload', async () => {
    servePull(pull(['lgtm', 'do-not-merge/hold']))
    const merge = observeMerge()
    const info = vi.spyOn(core, 'info')

    await expect(tideOnPullRequest(prEvent('labeled', { label: { name: 'lgtm' }, pull_request: { ...pullReqOpenedEvent.pull_request, labels: [{ name: 'lgtm' }] } }))).resolves.toBeUndefined()
    await expect(merge.notCalled()).resolves.toBe('not called')
    expect(info).toHaveBeenCalledWith('skipping pr #1: blocked by do-not-merge/hold')
  })

  it.each(['unlabeled', 'reopened', 'ready_for_review', 'edited'])('%s: evaluates the pr', async (action) => {
    const gets = servePull(pull(['lgtm']))
    const merge = observeMerge()

    await expect(tideOnPullRequest(prEvent(action))).resolves.toBeUndefined()
    await expect(merge.called()).resolves.toBe('called')
    expect(gets).toHaveLength(1)
  })

  it.each(['opened', 'synchronize', 'closed', 'assigned'])('%s: does not read the pr', async (action) => {
    const gets = servePull(pull(['lgtm']))
    const merge = observeMerge()
    const debug = vi.spyOn(core, 'debug')

    await expect(tideOnPullRequest(prEvent(action))).resolves.toBeUndefined()
    await expect(merge.notCalled()).resolves.toBe('not called')
    expect(gets).toHaveLength(0)
    expect(debug).toHaveBeenCalledWith(`tide: skipping ${action} action`)
  })

  it('uses tide.merge_method from the configuration', async () => {
    server.use(prowYaml('tide:\n  merge_method: rebase\n'))
    servePull(pull(['lgtm']))
    const merge = observeMerge()

    await tideOnPullRequest(prEvent('labeled'))
    await expect(merge.called()).resolves.toBe('called')
    expect(await merge.body()).toEqual({ merge_method: 'rebase', sha: 'headsha' })
  })

  it('merge_on_events: false makes the handler a no-op after reading the configuration', async () => {
    server.use(prowYaml('tide:\n  merge_on_events: false\n'))
    const gets = servePull(pull(['lgtm']))
    const merge = observeMerge()

    await expect(tideOnPullRequest(prEvent('labeled'))).resolves.toBeUndefined()
    await expect(merge.notCalled()).resolves.toBe('not called')
    expect(gets).toHaveLength(0)
  })

  it('throws when the merge is refused so the run fails', async () => {
    servePull(pull(['lgtm']))
    observeMerge(405, { message: 'Pull Request is not mergeable' })
    vi.spyOn(core, 'error').mockImplementation(() => {})

    await expect(tideOnPullRequest(prEvent('labeled'))).rejects.toThrow('could not merge pull request(s) #1')
  })

  it('throws when the payload has no pull request', async () => {
    await expect(tideOnPullRequest(new utils.MockContext({ action: 'labeled' }))).rejects.toThrow('missing pull request')
  })

  describe('on a repository with OWNERS files', () => {
    beforeEach(() => {
      server.use(utils.defaultBranchTree(['OWNERS', 'sdk/OWNERS']))
    })

    it('labeled lgtm without approved: one read, no merge, names the missing label', async () => {
      const gets = servePull(pull(['lgtm']))
      const merge = observeMerge()
      const info = vi.spyOn(core, 'info')

      await expect(tideOnPullRequest(prEvent('labeled', { label: { name: 'lgtm' } }))).resolves.toBeUndefined()
      await expect(merge.notCalled()).resolves.toBe('not called')
      expect(gets).toHaveLength(1)
      expect(info).toHaveBeenCalledWith('skipping pr #1: missing approved')
    })

    it('labeled approved with lgtm present: merges', async () => {
      servePull(pull(['lgtm', 'approved']))
      const merge = observeMerge()

      await expect(tideOnPullRequest(prEvent('labeled', { label: { name: 'approved' } }))).resolves.toBeUndefined()
      await expect(merge.called()).resolves.toBe('called')
    })

    it('a configured tide.labels wins and the tree is not read', async () => {
      const observeTree = new utils.ObserveRequest()
      server.use(prowYaml('tide:\n  labels: [lgtm]\n'), utils.defaultBranchTree(['OWNERS'], observeTree))
      servePull(pull(['lgtm']))
      const merge = observeMerge()

      await expect(tideOnPullRequest(prEvent('labeled', { label: { name: 'lgtm' } }))).resolves.toBeUndefined()
      await expect(merge.called()).resolves.toBe('called')
      await expect(observeTree.notCalled()).resolves.toBe('not called')
    })

    it('reads the tree once for several pull requests of one run', async () => {
      let trees = 0
      server.use(http.get(`${repo}/git/trees/master`, () => {
        trees++
        return new Response(JSON.stringify({ sha: 'x', truncated: false, tree: [{ path: 'OWNERS', type: 'blob', sha: 'a' }] }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }))
      server.use(
        http.get(`${repo}/pulls/:number`, ({ params }) => new Response(JSON.stringify(pull(['lgtm'], { number: Number(params.number) })), { status: 200, headers: { 'Content-Type': 'application/json' } })),
      )
      const context = new utils.MockContext({ ...checkSuiteCompletedEvent, check_suite: { ...checkSuiteCompletedEvent.check_suite, pull_requests: [{ number: 1 }, { number: 2 }] } })
      context.eventName = 'check_suite'
      const info = vi.spyOn(core, 'info')

      await expect(tideOnCheckSuite(context)).resolves.toBeUndefined()
      expect(trees).toBe(1)
      expect(info).toHaveBeenCalledWith('skipping pr #1: missing approved')
      expect(info).toHaveBeenCalledWith('skipping pr #2: missing approved')
    })

    it('the gate follows the pull request\'s base branch, not the default branch', async () => {
      const observeDefault = new utils.ObserveRequest()
      server.use(
        utils.defaultBranchTree([], observeDefault),
        http.get(`${repo}/git/trees/release-1`, utils.mockResponse(200, { sha: 'r', truncated: false, tree: [{ path: 'OWNERS', type: 'blob', sha: 'a' }] })),
      )
      servePull(pull(['lgtm'], { base: { ref: 'release-1', sha: 'basesha' } }))
      const merge = observeMerge()
      const info = vi.spyOn(core, 'info')

      await expect(tideOnPullRequest(prEvent('labeled', { label: { name: 'lgtm' } }))).resolves.toBeUndefined()
      await expect(merge.notCalled()).resolves.toBe('not called')
      expect(info).toHaveBeenCalledWith('skipping pr #1: missing approved')
      await expect(observeDefault.notCalled()).resolves.toBe('not called')
    })

    it('a base branch without OWNERS files keeps the [lgtm] gate although the default branch has them', async () => {
      server.use(http.get(`${repo}/git/trees/release-1`, utils.mockResponse(200, { sha: 'r', truncated: false, tree: [] })))
      servePull(pull(['lgtm'], { base: { ref: 'release-1', sha: 'basesha' } }))
      const merge = observeMerge()

      await expect(tideOnPullRequest(prEvent('labeled', { label: { name: 'lgtm' } }))).resolves.toBeUndefined()
      await expect(merge.called()).resolves.toBe('called')
    })
  })
})

describe('tideOnComment', () => {
  beforeEach(() => {
    server.use(...utils.noOrgOrRepoConfigExcept(), utils.defaultBranchTree())
  })

  it('evaluates the open pull request the comment is on', async () => {
    const gets = servePull(pull(['lgtm']))
    const merge = observeMerge()

    await expect(tideOnComment(new utils.MockContext(prCommentEvent('/lgtm')))).resolves.toBeUndefined()
    await expect(merge.called()).resolves.toBe('called')
    expect(gets).toHaveLength(1)
    expect(await merge.body()).toEqual({ merge_method: 'merge', sha: 'headsha' })
  })

  it('an issue is not read', async () => {
    const gets = servePull(pull(['lgtm']))
    const debug = vi.spyOn(core, 'debug')

    await expect(tideOnComment(new utils.MockContext({ ...prCommentEvent('/lgtm'), issue: { number: 1, state: 'open' } }))).resolves.toBeUndefined()
    expect(gets).toHaveLength(0)
    expect(debug).toHaveBeenCalledWith('tide: #1 is not a pull request')
  })

  it('a closed pull request is not read', async () => {
    const gets = servePull(pull(['lgtm']))
    const debug = vi.spyOn(core, 'debug')
    const event = prCommentEvent('/lgtm')
    event.issue.state = 'closed'

    await expect(tideOnComment(new utils.MockContext(event))).resolves.toBeUndefined()
    expect(gets).toHaveLength(0)
    expect(debug).toHaveBeenCalledWith('tide: pull request #1 is closed')
  })

  it('merge_on_events: false is a no-op after reading the configuration', async () => {
    server.use(prowYaml('tide:\n  merge_on_events: false\n'))
    const gets = servePull(pull(['lgtm']))
    const merge = observeMerge()

    await expect(tideOnComment(new utils.MockContext(prCommentEvent('/lgtm')))).resolves.toBeUndefined()
    await expect(merge.notCalled()).resolves.toBe('not called')
    expect(gets).toHaveLength(0)
  })

  it('throws when the merge is refused so the run fails', async () => {
    servePull(pull(['lgtm']))
    observeMerge(405, { message: 'Pull Request is not mergeable' })
    vi.spyOn(core, 'error').mockImplementation(() => {})

    await expect(tideOnComment(new utils.MockContext(prCommentEvent('/lgtm')))).rejects.toThrow('could not merge pull request(s) #1')
  })

  it('throws when the payload has no issue', async () => {
    await expect(tideOnComment(new utils.MockContext({ action: 'created' }))).rejects.toThrow('missing issue')
  })
})

describe('tideOnReview', () => {
  beforeEach(() => {
    server.use(...utils.noOrgOrRepoConfigExcept(), utils.defaultBranchTree())
  })

  it.each(['submitted', 'dismissed'])('%s: evaluates the reviewed pr', async (action) => {
    const gets = servePull(pull(['lgtm']))
    const merge = observeMerge()

    await expect(tideOnReview(new utils.MockContext({ ...reviewSubmittedEvent, action }))).resolves.toBeUndefined()
    await expect(merge.called()).resolves.toBe('called')
    expect(gets).toHaveLength(1)
  })

  it('edited: does not read the pr', async () => {
    const gets = servePull(pull(['lgtm']))

    await expect(tideOnReview(new utils.MockContext({ ...reviewSubmittedEvent, action: 'edited' }))).resolves.toBeUndefined()
    expect(gets).toHaveLength(0)
  })
})

describe('tideOnCheckSuite', () => {
  const sha = checkSuiteCompletedEvent.check_suite.head_sha

  function suiteEvent(overrides: Record<string, unknown> = {}, eventName = 'check_suite') {
    const context = new utils.MockContext({
      ...checkSuiteCompletedEvent,
      check_suite: { ...checkSuiteCompletedEvent.check_suite, ...overrides },
    })
    context.eventName = eventName
    return context
  }

  function servePulls(prs: { number: number, sha: string }[]) {
    const seen: string[] = []
    server.use(
      http.get(`${repo}/pulls`, ({ request }) => {
        const url = new URL(request.url)
        seen.push(url.search)
        const body = url.searchParams.get('page') === '1' ? prs.map(pr => ({ number: pr.number, head: { sha: pr.sha } })) : []
        return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }),
    )
    return seen
  }

  beforeEach(() => {
    server.use(...utils.noOrgOrRepoConfigExcept(), utils.defaultBranchTree())
  })

  it('completed success with pull_requests in the payload: evaluates them without listing', async () => {
    const gets = servePull(pull(['lgtm']))
    const merge = observeMerge()
    const seen = servePulls([])

    await expect(tideOnCheckSuite(suiteEvent({ pull_requests: [{ number: 1 }] }))).resolves.toBeUndefined()
    await expect(merge.called()).resolves.toBe('called')
    expect(gets).toHaveLength(1)
    expect(seen).toEqual([])
  })

  it('completed success with no pull_requests: looks the open prs up by head sha', async () => {
    const gets = servePull(pull(['lgtm']))
    const merge = observeMerge()
    const seen = servePulls([{ number: 1, sha }, { number: 3, sha: 'other' }])

    await expect(tideOnCheckSuite(suiteEvent())).resolves.toBeUndefined()
    await expect(merge.called()).resolves.toBe('called')
    expect(gets).toHaveLength(1)
    expect(seen).toEqual(['?state=open&per_page=100&page=1', '?state=open&per_page=100&page=2'])
  })

  it('no open pr has the sha: nothing to evaluate', async () => {
    const gets = servePull(pull(['lgtm']))
    servePulls([])
    const debug = vi.spyOn(core, 'debug')

    await expect(tideOnCheckSuite(suiteEvent())).resolves.toBeUndefined()
    expect(gets).toHaveLength(0)
    expect(debug).toHaveBeenCalledWith('tide: no open pull request to evaluate')
  })

  it.each(['failure', 'cancelled', 'timed_out', 'action_required'])('conclusion %s: makes no api call', async (conclusion) => {
    const gets = servePull(pull(['lgtm']))
    const seen = servePulls([{ number: 1, sha }])

    await expect(tideOnCheckSuite(suiteEvent({ conclusion, pull_requests: [{ number: 1 }] }))).resolves.toBeUndefined()
    expect(gets).toHaveLength(0)
    expect(seen).toEqual([])
  })

  it.each(['success', 'neutral', 'skipped'])('conclusion %s: evaluates', async (conclusion) => {
    servePull(pull(['lgtm']))
    const merge = observeMerge()

    await tideOnCheckSuite(suiteEvent({ conclusion, pull_requests: [{ number: 1 }] }))
    await expect(merge.called()).resolves.toBe('called')
  })

  it('status success: looks the prs up by the payload sha', async () => {
    servePull(pull(['lgtm']))
    const merge = observeMerge()
    const seen = servePulls([{ number: 1, sha }])
    const context = new utils.MockContext({ sha, state: 'success', context: 'ci/lint', repository: checkSuiteCompletedEvent.repository })
    context.eventName = 'status'

    await expect(tideOnCheckSuite(context)).resolves.toBeUndefined()
    await expect(merge.called()).resolves.toBe('called')
    expect(seen).toHaveLength(2)
  })

  it.each(['pending', 'failure', 'error'])('status %s: makes no api call', async (state) => {
    const seen = servePulls([{ number: 1, sha }])
    const context = new utils.MockContext({ sha, state, context: 'ci/lint', repository: checkSuiteCompletedEvent.repository })
    context.eventName = 'status'

    await expect(tideOnCheckSuite(context)).resolves.toBeUndefined()
    expect(seen).toEqual([])
  })

  it('merge_on_events: false skips the lookup', async () => {
    server.use(prowYaml('tide:\n  merge_on_events: false\n'))
    const seen = servePulls([{ number: 1, sha }])

    await expect(tideOnCheckSuite(suiteEvent())).resolves.toBeUndefined()
    expect(seen).toEqual([])
  })

  it('lists every failed merge in the error', async () => {
    server.use(
      http.get(`${repo}/pulls/:number`, ({ params }) => new Response(JSON.stringify(pull(['lgtm'], { number: Number(params.number) })), { status: 200, headers: { 'Content-Type': 'application/json' } })),
      http.put(`${repo}/pulls/:number/merge`, utils.mockResponse(405, { message: 'Pull Request is not mergeable' })),
    )
    vi.spyOn(core, 'error').mockImplementation(() => {})

    await expect(tideOnCheckSuite(suiteEvent({ pull_requests: [{ number: 1 }, { number: 2 }] }))).rejects.toThrow('could not merge pull request(s) #1, #2')
  })

  it('throws when the payload has no sha', async () => {
    const context = new utils.MockContext({ action: 'completed' })
    context.eventName = 'check_suite'
    await expect(tideOnCheckSuite(context)).rejects.toThrow('missing head sha')
  })
})
