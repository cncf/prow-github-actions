import type { HttpHandler } from 'msw'
import { Buffer } from 'node:buffer'
import * as core from '@actions/core'
import { http } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { handleIssueComment } from '../../src/issueComment/handleIssueComment'
import { autoCc, blunderbuss, blunderbussSettings, pickReviewers } from '../../src/plugins/blunderbuss'
import { handlePullReq, pullRequestHandlers } from '../../src/pullReq/handlePullReq'
import issueCommentEvent from '../fixtures/issues/issueCommentEvent.json'
import labelFileContents from '../fixtures/labels/labelFileContentsResp.json'
import pullReqOpenedEvent from '../fixtures/pullReq/pullReqOpenedEvent.json'
import * as utils from '../testUtils'
import { baseSha, changedFiles, filesHandler, prCommentEvent, repo, treeHandlers } from '../utils/ownersFixtures'

const server = setupServer()
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

const project = 'Codertocat/.project:prow.yaml'

const rootOwners = 'approvers:\n- alice\nreviewers:\n- rita\n'
const sdkOwners = 'approvers:\n- bob\nreviewers:\n- carol\n- dave\n'
const owners = { 'OWNERS': rootOwners, 'sdk/OWNERS': sdkOwners }

function prEvent(action: string) {
  return new utils.MockContext({ ...structuredClone(pullReqOpenedEvent), action })
}

interface PullOverrides {
  author?: string
  draft?: boolean
  requested?: string[]
  assignees?: string[]
}

function pullHandler({ author = 'some-author', draft = false, requested = [], assignees = [] }: PullOverrides = {}): HttpHandler {
  return http.get(`${repo}/pulls/1`, utils.mockResponse(200, {
    base: { sha: baseSha },
    user: { login: author },
    draft,
    requested_reviewers: requested.map(login => ({ login })),
    assignees: assignees.map(login => ({ login })),
  }))
}

function servePr(ownersFiles: Record<string, string>, files: string[], pull: PullOverrides = {}) {
  server.use(pullHandler(pull), filesHandler(changedFiles(...files)), ...treeHandlers(ownersFiles))
}

function serveConfig(yaml?: string) {
  if (yaml === undefined) {
    server.use(...utils.noOrgOrRepoConfigExcept())
    return
  }
  const file = structuredClone(labelFileContents)
  file.content = Buffer.from(yaml).toString('base64')
  server.use(
    http.get(utils.contentsUrl(project), utils.mockResponse(200, file)),
    ...utils.noOrgOrRepoConfigExcept(project),
  )
}

function observeRequestReviewers(status = 201): utils.ObserveRequest {
  const observe = new utils.ObserveRequest()
  server.use(http.post(`${repo}/pulls/1/requested_reviewers`, utils.mockResponse(status, status < 300 ? {} : { message: 'boom' }, observe)))
  return observe
}

async function requested(observe: utils.ObserveRequest): Promise<string[]> {
  await observe.called()
  const body = await observe.body() as { reviewers: string[] }
  return [...body.reviewers].sort()
}

// an rng that always returns 0 picks the first remaining element at every step
const first = () => 0
// an rng that returns just under 1 picks the last remaining element at every step
const last = () => 0.999

describe('pickReviewers', () => {
  const scores = new Map([['alice', 2], ['bob', 2], ['carol', 1], ['dave', 1]])

  it('fills from the highest tier, at random within a tier', () => {
    expect(pickReviewers(scores, 1, first)).toEqual(['alice'])
    expect(pickReviewers(scores, 1, last)).toEqual(['bob'])
  })

  it('takes a whole tier that fits, then draws the rest from the next tier', () => {
    expect(pickReviewers(scores, 3, first).sort()).toEqual(['alice', 'bob', 'carol'])
    expect(pickReviewers(scores, 3, last).sort()).toEqual(['alice', 'bob', 'dave'])
  })

  it('returns everyone, highest tier first, when there are fewer candidates than requested', () => {
    const picked = pickReviewers(scores, 10, first)

    expect(picked).toHaveLength(4)
    expect(picked.slice(0, 2).sort()).toEqual(['alice', 'bob'])
    expect(picked.slice(2).sort()).toEqual(['carol', 'dave'])
  })

  it('is empty for zero requests or no candidates', () => {
    expect(pickReviewers(scores, 0, first)).toEqual([])
    expect(pickReviewers(new Map(), 2, first)).toEqual([])
  })

  it('draws every element of a tier with a real rng exactly once', () => {
    const picked = pickReviewers(new Map([['a', 1], ['b', 1], ['c', 1]]), 3)

    expect([...picked].sort()).toEqual(['a', 'b', 'c'])
  })
})

describe('blunderbussSettings', () => {
  it('applies the defaults', () => {
    expect(blunderbussSettings({ labels: {}, require_matching_label: [], tide: {}, hold: {}, blunderbuss: {}, sources: [] })).toEqual({
      request_count: 2,
      max_request_count: undefined,
      exclude_approvers: false,
      ignore_drafts: true,
      ignore_authors: [],
    })
  })

  it('lowercases ignore_authors', () => {
    expect(blunderbussSettings({ labels: {}, require_matching_label: [], tide: {}, hold: {}, blunderbuss: { ignore_authors: ['Dependabot[bot]'] }, sources: [] }).ignore_authors).toEqual(['dependabot[bot]'])
  })
})

describe('blunderbuss handler', () => {
  let setFailed: ReturnType<typeof vi.spyOn>
  let debug: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    utils.setupActionsEnv()
    setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})
    debug = vi.spyOn(core, 'debug').mockImplementation(() => {})
  })

  it('opened: requests two reviewers from the OWNERS covering the changed files, excluding the author', async () => {
    serveConfig()
    servePr(owners, ['sdk/x.go'], { author: 'Carol' })
    const observe = observeRequestReviewers()

    await blunderbuss(prEvent('opened'), first)

    // every candidate covers one file; the rng picks alice and bob from the sorted tier
    expect(await requested(observe)).toEqual(['alice', 'bob'])
    expect(setFailed).not.toHaveBeenCalled()
  })

  it('weights candidates by the number of changed files they cover', async () => {
    serveConfig('blunderbuss:\n  request_count: 1\n')
    servePr(owners, ['sdk/x.go', 'docs/y.md'])
    const observe = observeRequestReviewers()

    await blunderbuss(prEvent('opened'), last)

    // alice and rita cover both files, the sdk owners only one; the rng picks the last of the top tier
    expect(await requested(observe)).toEqual(['rita'])
  })

  it('honours request_count', async () => {
    serveConfig('blunderbuss:\n  request_count: 3\n')
    servePr(owners, ['sdk/x.go'])
    const observe = observeRequestReviewers()

    await blunderbuss(prEvent('opened'), first)

    expect(await requested(observe)).toHaveLength(3)
  })

  it('skips already requested reviewers and assignees', async () => {
    serveConfig()
    servePr(owners, ['sdk/x.go'], { requested: ['Alice', 'bob'], assignees: ['carol'] })
    const observe = observeRequestReviewers()

    await blunderbuss(prEvent('opened'), first)

    expect(await requested(observe)).toEqual(['dave', 'rita'])
  })

  it('exclude_approvers only considers reviewers', async () => {
    serveConfig('blunderbuss:\n  exclude_approvers: true\n  request_count: 4\n')
    servePr(owners, ['sdk/x.go'])
    const observe = observeRequestReviewers()

    await blunderbuss(prEvent('opened'))

    expect(await requested(observe)).toEqual(['carol', 'dave', 'rita'])
  })

  it('max_request_count caps the request given the reviewers already requested', async () => {
    serveConfig('blunderbuss:\n  request_count: 2\n  max_request_count: 3\n')
    servePr(owners, ['sdk/x.go'], { requested: ['zed', 'yan'] })
    const observe = observeRequestReviewers()

    await blunderbuss(prEvent('opened'), first)

    expect(await requested(observe)).toEqual(['alice'])
  })

  it('does nothing when max_request_count is already reached', async () => {
    serveConfig('blunderbuss:\n  request_count: 2\n  max_request_count: 2\n')
    servePr(owners, ['sdk/x.go'], { requested: ['zed', 'yan'] })
    const observe = observeRequestReviewers()

    await blunderbuss(prEvent('opened'))

    await expect(observe.notCalled()).resolves.toBe('not called')
    expect(debug).toHaveBeenCalledWith('blunderbuss: #1 already has 2 requested reviewers, max_request_count is 2')
  })

  it('opened: leaves a draft alone by default', async () => {
    serveConfig()
    servePr(owners, ['sdk/x.go'], { draft: true })
    const observe = observeRequestReviewers()

    await blunderbuss(prEvent('opened'))

    await expect(observe.notCalled()).resolves.toBe('not called')
    expect(debug).toHaveBeenCalledWith('blunderbuss: #1 is a draft, waiting for ready_for_review')
  })

  it('ready_for_review: requests reviewers for the former draft', async () => {
    serveConfig()
    servePr(owners, ['sdk/x.go'])
    const observe = observeRequestReviewers()

    await blunderbuss(prEvent('ready_for_review'), first)

    expect(await requested(observe)).toEqual(['alice', 'bob'])
  })

  it('ignore_drafts: false requests on an opened draft and skips ready_for_review', async () => {
    serveConfig('blunderbuss:\n  ignore_drafts: false\n')
    servePr(owners, ['sdk/x.go'], { draft: true })
    const observe = observeRequestReviewers()

    await blunderbuss(prEvent('opened'), first)
    expect(await requested(observe)).toEqual(['alice', 'bob'])

    utils.setupActionsEnv()
    serveConfig('blunderbuss:\n  ignore_drafts: false\n')
    servePr(owners, ['sdk/x.go'])
    const again = observeRequestReviewers()

    await blunderbuss(prEvent('ready_for_review'))

    await expect(again.notCalled()).resolves.toBe('not called')
    expect(debug).toHaveBeenCalledWith('blunderbuss: skipping ready_for_review action')
  })

  it('ignore_authors skips the pull request, compared case-insensitively', async () => {
    serveConfig('blunderbuss:\n  ignore_authors: ["Dependabot[bot]"]\n')
    servePr(owners, ['sdk/x.go'], { author: 'dependabot[bot]' })
    const observe = observeRequestReviewers()

    await blunderbuss(prEvent('opened'))

    await expect(observe.notCalled()).resolves.toBe('not called')
    expect(debug).toHaveBeenCalledWith('blunderbuss: ignoring pull request by dependabot[bot]')
  })

  it('does nothing when the OWNERS covering the changed files name nobody but the author', async () => {
    serveConfig()
    servePr({ 'sdk/OWNERS': 'reviewers:\n- carol\n' }, ['sdk/x.go'], { author: 'carol' })
    const observe = observeRequestReviewers()

    await blunderbuss(prEvent('opened'))

    await expect(observe.notCalled()).resolves.toBe('not called')
    expect(debug).toHaveBeenCalledWith('blunderbuss: no reviewer candidates for #1')
  })

  it('does nothing when the repository has no OWNERS files', async () => {
    serveConfig()
    servePr({}, ['src/file1.txt'])
    const observe = observeRequestReviewers()

    await blunderbuss(prEvent('opened'))

    await expect(observe.notCalled()).resolves.toBe('not called')
  })

  it.each(['reopened', 'synchronize', 'labeled', 'edited', 'closed'])('%s: skips without calling the api', async (action) => {
    const observePull = new utils.ObserveRequest()
    server.use(http.get(`${repo}/pulls/1`, utils.mockResponse(200, {}, observePull)))

    await blunderbuss(prEvent(action))

    expect(debug).toHaveBeenCalledWith(`blunderbuss: skipping ${action} action`)
    await expect(observePull.notCalled()).resolves.toBe('not called')
  })

  it('fails when the review request is refused', async () => {
    serveConfig()
    servePr(owners, ['sdk/x.go'])
    observeRequestReviewers(500)

    await expect(blunderbuss(prEvent('opened'))).rejects.toThrow(/could not request reviewers: .*boom/)
  })

  it('fails without a pull request in the payload', async () => {
    await expect(blunderbuss(new utils.MockContext({ action: 'opened' }))).rejects.toThrow(
      'github context payload missing pull request',
    )
  })

  it('is registered on the pull_request event after owners-label and shares its OWNERS fetch', async () => {
    expect(pullRequestHandlers.map(handler => handler.name)).toEqual(['requireMatchingLabel', 'ownersLabel', 'blunderbuss'])

    utils.setupJobsEnv('')
    serveConfig()
    let pulls = 0
    server.use(
      http.get(`${repo}/pulls/1`, () => {
        pulls++
        return new Response(JSON.stringify({ base: { sha: baseSha }, user: { login: 'some-author' }, draft: false, requested_reviewers: [], assignees: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }),
      filesHandler(changedFiles('sdk/x.go')),
      ...treeHandlers({ 'sdk/OWNERS': `${sdkOwners}labels:\n- area/sdk\n` }),
      http.get(`${repo}/issues/1`, utils.mockResponse(200, { labels: [] })),
      utils.repoHasLabels(['area/sdk']),
      http.post(`${repo}/issues/1/labels`, utils.mockResponse(200, [])),
    )
    const observe = observeRequestReviewers()

    await handlePullReq(prEvent('opened'))

    expect(await requested(observe)).toHaveLength(2)
    expect(pulls).toBe(1)
    expect(setFailed).not.toHaveBeenCalled()
  })
})

describe('/auto-cc', () => {
  let setFailed: ReturnType<typeof vi.spyOn>
  let debug: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    utils.setupActionsEnv('/auto-cc')
    setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})
    debug = vi.spyOn(core, 'debug').mockImplementation(() => {})
  })

  it('requests reviewers on a draft regardless of ignore_drafts and ignore_authors', async () => {
    serveConfig('blunderbuss:\n  ignore_authors: [some-author]\n')
    servePr(owners, ['sdk/x.go'], { draft: true })
    const observe = observeRequestReviewers()

    await handleIssueComment(new utils.MockContext(prCommentEvent('/auto-cc')))

    expect(await requested(observe)).toHaveLength(2)
    expect(setFailed).not.toHaveBeenCalled()
  })

  it('honours request_count and the exclusions', async () => {
    serveConfig('blunderbuss:\n  request_count: 1\n')
    servePr(owners, ['sdk/x.go'], { author: 'alice', requested: ['bob'], assignees: ['carol', 'dave'] })
    const observe = observeRequestReviewers()

    await autoCc(new utils.MockContext(prCommentEvent('/auto-cc')))

    expect(await requested(observe)).toEqual(['rita'])
  })

  it('does nothing on an issue', async () => {
    const observePull = new utils.ObserveRequest()
    server.use(http.get(`${repo}/pulls/1`, utils.mockResponse(200, {}, observePull)))

    await handleIssueComment(new utils.MockContext({ ...structuredClone(issueCommentEvent), comment: { ...issueCommentEvent.comment, body: '/auto-cc' } }))

    expect(debug).toHaveBeenCalledWith('blunderbuss: /auto-cc only applies to pull requests')
    await expect(observePull.notCalled()).resolves.toBe('not called')
    expect(setFailed).not.toHaveBeenCalled()
  })

  it('has no /remove- form and does not run when not configured', async () => {
    await handleIssueComment(new utils.MockContext(prCommentEvent('/remove-auto-cc')))
    expect(setFailed).not.toHaveBeenCalled()

    utils.setupActionsEnv('/kind')
    await handleIssueComment(new utils.MockContext(prCommentEvent('/auto-cc')))
    expect(setFailed).not.toHaveBeenCalled()
  })

  it('fails the run when the review request is refused', async () => {
    serveConfig()
    servePr(owners, ['sdk/x.go'])
    observeRequestReviewers(500)

    await handleIssueComment(new utils.MockContext(prCommentEvent('/auto-cc')))

    expect(setFailed).toHaveBeenCalledExactlyOnceWith(
      expect.stringMatching(/^TypeError: error handling issue comment: Error: could not request reviewers: .*boom/),
    )
  })
})
