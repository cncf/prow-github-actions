import type { ApprovalEvent, ApprovalEventKind, ApproveSettings } from '../../src/plugins/approve'
import type { PullRequestOwners } from '../../src/utils/pullRequestOwners'

import * as core from '@actions/core'
import { http } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { approveOnPullRequest, computeApproval, notifierMarker, renderNotifier } from '../../src/plugins/approve'
import { effectiveOwners, ownersDir, parseOwners } from '../../src/utils/owners'
import pullReqOpenedEvent from '../fixtures/pullReq/pullReqOpenedEvent.json'
import * as utils from '../testUtils'
import { prHandlers, repo } from '../utils/ownersFixtures'

const server = setupServer()
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

const defaults: ApproveSettings = { require_self_approval: false, ignore_review_state: false, lgtm_acts_as_approve: false, github_review: false }
const sdkOwners = 'approvers:\n- bob\n'
const link = (path: string) => `https://github.com/Codertocat/Hello-World/blob/basesha/${path}`

function pullOwners(ownersFiles: Record<string, string>, files: string[], author = 'author'): PullRequestOwners {
  const parsed = Object.entries(ownersFiles).map(([path, contents]) => parseOwners(path, contents))
  const tree = { owners: new Map(parsed.map(file => [ownersDir(file.path), file])), hasOwners: parsed.length > 0 }
  return {
    number: 1,
    baseSha: 'basesha',
    author,
    draft: false,
    open: true,
    requestedReviewers: [],
    assignees: [],
    labels: [],
    files,
    tree,
    perFile: new Map(files.map(file => [file, effectiveOwners(file, tree.owners)])),
  }
}

describe('computeApproval', () => {
  it('ignores an event whose kind it does not know', () => {
    const owners = pullOwners({ 'sdk/OWNERS': sdkOwners }, ['sdk/x.go'], 'author')
    const unknown: ApprovalEvent = { user: 'bob', kind: 'blessed' as ApprovalEventKind, at: new Date(1000) }

    const state = computeApproval(owners, [unknown], defaults)

    expect(state.approved).toBe(false)
    expect([...state.approvers]).toEqual([])
    expect(state.suggested).toEqual(['bob'])
  })
})

describe('renderNotifier', () => {
  it('lists the files no OWNERS file covers in name order after the OWNERS files', () => {
    const owners = pullOwners({ 'sdk/OWNERS': sdkOwners }, ['zeta.go', 'sdk/x.go', 'alpha.go'])
    const state = computeApproval(owners, [{ user: 'bob', kind: 'approve', at: new Date(1000) }], defaults)

    const body = renderNotifier(state, owners, { owner: 'Codertocat', repo: 'Hello-World' })

    expect(body.match(/^- .*$/gm)).toEqual([
      `- ~~[sdk/OWNERS](${link('sdk/OWNERS')})~~ [bob]`,
      '- **alpha.go** (no OWNERS file covers this file)',
      '- **zeta.go** (no OWNERS file covers this file)',
    ])
  })
})

interface Comment {
  id?: number
  body: string
  user: { login: string, type?: string }
}

const bot = { login: 'github-actions[bot]', type: 'Bot' }

// the reads of one approval evaluation; each test overrides the request it wants to fail
function serve(files: string[] = ['sdk/x.go'], comments: Comment[] = [], author = 'some-author') {
  const postComment = new utils.ObserveRequest()
  server.use(
    ...utils.noOrgOrRepoConfigExcept(),
    ...prHandlers({ 'sdk/OWNERS': sdkOwners }, files, { user: { login: author }, labels: [] }),
    utils.defaultBranchTree(['sdk/OWNERS']),
    utils.repoHasLabels(['approved', 'lgtm']),
    http.get(`${repo}/issues/1/comments`, utils.mockResponse(200, comments.map((c, i) => ({ id: c.id ?? 100 + i, created_at: new Date(Date.UTC(2024, 0, 1, 0, 0, i + 1)).toISOString(), ...c })))),
    http.get(`${repo}/pulls/1/reviews`, utils.mockResponse(200, [])),
    http.post(`${repo}/issues/1/labels`, utils.mockResponse(200, [])),
    http.post(`${repo}/issues/1/comments`, utils.mockResponse(201, {}, postComment)),
  )
  return { postComment }
}

function prEvent(action: string, extra: Record<string, unknown> = {}) {
  return new utils.MockContext({ ...pullReqOpenedEvent, action, ...extra })
}

let debug: ReturnType<typeof vi.spyOn>
let info: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  utils.setupActionsEnv()
  debug = vi.spyOn(core, 'debug')
  info = vi.spyOn(core, 'info').mockImplementation(() => {})
})

describe('approveOnPullRequest error paths', () => {
  it('throws when listing the comments fails', async () => {
    serve()
    server.use(http.get(`${repo}/issues/1/comments`, utils.mockResponse(500, { message: 'boom' })))

    await expect(approveOnPullRequest(prEvent('opened'))).rejects.toThrow('could not list comments')
  })

  it('throws when listing the reviews fails', async () => {
    serve()
    server.use(http.get(`${repo}/pulls/1/reviews`, utils.mockResponse(500, { message: 'boom' })))

    await expect(approveOnPullRequest(prEvent('opened'))).rejects.toThrow('could not list reviews')
  })

  it('throws when editing the stale notifier fails', async () => {
    const stale: Comment = { id: 900, body: `[APPROVALNOTIFIER] This PR is **NOT APPROVED**\n\nstale\n${notifierMarker}`, user: bot }
    const { postComment } = serve(['sdk/x.go'], [stale, { body: '/approve', user: { login: 'bob' } }])
    server.use(http.patch(`${repo}/issues/comments/900`, utils.mockResponse(500, { message: 'boom' })))

    await expect(approveOnPullRequest(prEvent('opened'))).rejects.toThrow('could not update the approval notifier')
    await expect(postComment.notCalled()).resolves.toBe('not called')
  })

  it('a pull request that changes no files: nobody approves anything and the notifier says so', async () => {
    const { postComment } = serve([])

    await approveOnPullRequest(prEvent('opened'))

    await expect(postComment.called()).resolves.toBe('called')
    expect((await postComment.body()).body).toContain('This pull request changes no files, so there is nothing to approve.')
    expect(info).toHaveBeenCalledWith('approve: #1 is not approved; nobody approves anything')
  })

  it('labeled without a label in the payload does not concern approval', async () => {
    const observeTree = new utils.ObserveRequest()
    server.use(utils.defaultBranchTree(['sdk/OWNERS'], observeTree))

    await approveOnPullRequest(prEvent('labeled', { label: undefined }))

    expect(debug).toHaveBeenCalledWith('approve: labeled undefined does not concern approval')
    await expect(observeTree.notCalled()).resolves.toBe('not called')
  })

  it('probes the default branch for OWNERS files when the payload has no base ref', async () => {
    const { postComment } = serve()
    const observeTrunk = new utils.ObserveRequest()
    server.use(http.get(`${repo}/git/trees/trunk`, utils.mockResponse(200, {
      sha: 'trunk',
      truncated: false,
      tree: [{ path: 'sdk/OWNERS', mode: '100644', type: 'blob', sha: 'blob-sdk-OWNERS' }],
    }, observeTrunk)))
    const context = prEvent('opened', {
      pull_request: { ...pullReqOpenedEvent.pull_request, base: undefined },
      repository: { ...pullReqOpenedEvent.repository, default_branch: 'trunk' },
    })

    await approveOnPullRequest(context)

    await expect(observeTrunk.called()).resolves.toBe('called')
    await expect(postComment.called()).resolves.toBe('called')
  })
})
