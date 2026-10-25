import type { ApprovalEvent, ApproveSettings } from '../../src/plugins/approve'
import type { PullRequestOwners } from '../../src/utils/pullRequestOwners'

import * as core from '@actions/core'
import { http } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { approvalEvents, approveOnPullRequest, approveOnReview, computeApproval, notifierMarker, renderNotifier } from '../../src/plugins/approve'
import { effectiveOwners, ownersDir, parseOwners } from '../../src/utils/owners'
import pullReqOpenedEvent from '../fixtures/pullReq/pullReqOpenedEvent.json'
import * as utils from '../testUtils'
import { prHandlers, repo } from '../utils/ownersFixtures'

// Guards of src/plugins/approve.ts that line coverage reaches but no other
// test would notice changing: each case here fails when the guard it names is
// removed or inverted.

const server = setupServer()
beforeAll(() => server.listen(utils.failOnUnhandledRequest))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

const defaults: ApproveSettings = { require_self_approval: false, ignore_review_state: false, lgtm_acts_as_approve: false, github_review: false }

const twoDirs = {
  'OWNERS': 'approvers:\n- alice\n',
  'sdk/OWNERS': 'approvers:\n- bob\n',
  'olm/OWNERS': 'options:\n  no_parent_owners: true\napprovers:\n- carol\n',
}
const twoFiles = ['sdk/x.go', 'olm/y.go']

interface Actor { login: string, type?: string }
interface Comment { id?: number, body: string | null, user: Actor | null, created_at?: string }

const bot: Actor = { login: 'github-actions[bot]', type: 'Bot' }

function stamp(index: number): string {
  return new Date(Date.UTC(2024, 0, 1, 0, 0, index)).toISOString()
}

// the OWNERS of a pull request as loadPullRequestOwners would resolve them, without the network
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

let clock = 0
function at(user: string, kind: ApprovalEvent['kind']): ApprovalEvent {
  clock += 1000
  return { user, kind, at: new Date(clock) }
}

interface Scenario {
  owners?: Record<string, string>
  files?: string[]
  author?: string
  labels?: string[]
  comments?: Comment[]
  /** the default branch tree; defaults to the same OWNERS paths as `owners` */
  defaultBranch?: string[]
}

// the reads and writes of one approval evaluation, with an observer per write
function serve(scenario: Scenario = {}) {
  const {
    owners = twoDirs,
    files = twoFiles,
    author = 'some-author',
    labels = [],
    comments = [],
    defaultBranch = Object.keys(owners),
  } = scenario

  const writes = {
    addLabels: new utils.ObserveRequest(),
    removeLabel: new utils.ObserveRequest(),
    postComment: new utils.ObserveRequest(),
    patchComment: new utils.ObserveRequest(),
  }

  server.use(
    ...utils.noOrgOrRepoConfigExcept(),
    ...prHandlers(owners, files, { user: { login: author }, labels: labels.map(name => ({ name })) }),
    utils.defaultBranchTree(defaultBranch),
    utils.repoHasLabels(['approved', 'lgtm']),
    http.get(`${repo}/issues/1/comments`, utils.mockResponse(200, comments.map((c, i) => ({ id: c.id ?? 100 + i, created_at: stamp(i + 1), ...c })))),
    http.get(`${repo}/pulls/1/reviews`, utils.mockResponse(200, [])),
    http.post(`${repo}/issues/1/labels`, utils.mockResponse(200, [], writes.addLabels)),
    http.delete(`${repo}/issues/1/labels/approved`, utils.mockResponse(200, [], writes.removeLabel)),
    http.post(`${repo}/issues/1/comments`, utils.mockResponse(201, {}, writes.postComment)),
    http.patch(`${repo}/issues/comments/900`, utils.mockResponse(200, {}, writes.patchComment)),
  )

  return writes
}

function prEvent(action: string, extra: Record<string, unknown> = {}) {
  return new utils.MockContext({ ...pullReqOpenedEvent, action, ...extra })
}

async function commentBody(observe: utils.ObserveRequest): Promise<string> {
  return (await observe.body()).body
}

// the notifier evaluateApproval renders for the default scenario once bob and carol approved
function approvedNotifier(): string {
  const owners = pullOwners(twoDirs, twoFiles, 'some-author')
  return renderNotifier(computeApproval(owners, [at('bob', 'approve'), at('carol', 'approve')], defaults), owners, { owner: 'Codertocat', repo: 'Hello-World' })
}

let debug: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  utils.setupActionsEnv()
  vi.spyOn(core, 'setFailed').mockImplementation(() => {})
  debug = vi.spyOn(core, 'debug')
})

describe('approvalEvents', () => {
  it('skips a github-actions[bot] comment even when its user carries no Bot type', () => {
    expect(approvalEvents([
      { id: 1, body: '/approve', user: { login: 'github-actions[bot]' }, created_at: '2024-01-01T00:00:01Z' },
      { id: 2, body: '/approve', user: { login: 'github-actions[bot]', type: 'User' }, created_at: '2024-01-01T00:00:02Z' },
    ], [])).toEqual([])
  })
})

describe('computeApproval', () => {
  it('still suggests an approver when another changed file has no OWNERS coverage at all', () => {
    const owners = pullOwners({ 'sdk/OWNERS': 'approvers:\n- bob\n' }, ['sdk/x.go', 'README.md'])

    const state = computeApproval(owners, [], defaults)

    expect(state.uncoveredFiles).toEqual(['sdk/x.go', 'README.md'])
    expect(state.suggested).toEqual(['bob'])
  })

  it('logs an approver who covers none of the changed files, and nothing for a pull request without an author', () => {
    const owners = pullOwners({ 'sdk/OWNERS': 'approvers:\n- bob\n- carol\n' }, ['sdk/x.go'], '')

    const state = computeApproval(owners, [at('bob', 'approve'), at('dave', 'approve')], defaults)

    expect([...state.approvers]).toEqual(['bob'])
    expect(debug).toHaveBeenCalledWith('approve: dave approves none of the changed files of #1; ignored')
    expect(debug).not.toHaveBeenCalledWith('approve: bob approves none of the changed files of #1; ignored')
    expect(debug).not.toHaveBeenCalledWith('approve:  approves none of the changed files of #1; ignored')
  })
})

describe('renderNotifier', () => {
  it('a pull request with no changed files renders exactly the verdict, the explanation and the marker', () => {
    const owners = pullOwners({ OWNERS: 'approvers:\n- alice\n' }, [])

    const body = renderNotifier(computeApproval(owners, [], defaults), owners, { owner: 'Codertocat', repo: 'Hello-World' })

    expect(body).toBe([
      '[APPROVALNOTIFIER] This PR is **NOT APPROVED**',
      '',
      'This pull request changes no files, so there is nothing to approve.',
      '<!-- prow-github-actions/approve -->',
    ].join('\n'))
  })
})

describe('approveOnPullRequest', () => {
  it('unlabeled with another label makes no api call at all', async () => {
    const observeTree = new utils.ObserveRequest()
    server.use(utils.defaultBranchTree(['OWNERS'], observeTree))

    await approveOnPullRequest(prEvent('unlabeled', { label: { name: 'lgtm' } }))

    await expect(observeTree.notCalled()).resolves.toBe('not called')
    expect(debug).toHaveBeenCalledWith('approve: unlabeled lgtm does not concern approval')
  })

  it('probes the OWNERS of the base branch, not of the default branch: a base with OWNERS is evaluated even when the default branch has none', async () => {
    const writes = serve({ owners: { OWNERS: 'approvers:\n- some-author\n' }, files: ['src/a.go'], defaultBranch: [] })
    const observeBase = new utils.ObserveRequest()
    server.use(http.get(`${repo}/git/trees/release-1.0`, utils.mockResponse(200, { sha: 'release-1.0', truncated: false, tree: [{ path: 'OWNERS', mode: '100644', type: 'blob', sha: 'blob-OWNERS' }] }, observeBase)))
    const base = { ...pullReqOpenedEvent.pull_request.base, ref: 'release-1.0' }

    await approveOnPullRequest(prEvent('opened', { pull_request: { ...pullReqOpenedEvent.pull_request, base } }))

    await expect(observeBase.called()).resolves.toBe('called')

    await expect(writes.addLabels.called()).resolves.toBe('called')
    await expect(writes.postComment.called()).resolves.toBe('called')
    expect(await commentBody(writes.postComment)).toContain('This PR is **APPROVED**')
  })

  it('fails without the github-token input before reading anything', async () => {
    delete process.env['INPUT_GITHUB-TOKEN']
    const observeTree = new utils.ObserveRequest()
    server.use(utils.defaultBranchTree(['OWNERS'], observeTree))

    await expect(approveOnPullRequest(prEvent('opened'))).rejects.toThrow('Input required and not supplied: github-token')

    await expect(observeTree.notCalled()).resolves.toBe('not called')
  })

  it('a stale notifier by a github-actions[bot] user without a Bot type is edited in place, past a comment whose user is gone', async () => {
    const stale: Comment = { id: 900, body: `[APPROVALNOTIFIER] This PR is **NOT APPROVED**\n\nstale\n${notifierMarker}`, user: { login: 'github-actions[bot]' } }
    const writes = serve({ comments: [{ body: 'hello from a deleted account', user: null }, stale, { body: '/approve', user: { login: 'bob' } }] })

    await approveOnPullRequest(prEvent('opened'))

    await expect(writes.patchComment.called()).resolves.toBe('called')
    await expect(writes.postComment.notCalled()).resolves.toBe('not called')
  })

  it('a notifier that differs only by surrounding whitespace is up to date', async () => {
    const writes = serve({
      labels: ['approved'],
      comments: [
        { id: 900, body: `${approvedNotifier()}\n`, user: bot },
        { body: '/approve', user: { login: 'bob' } },
        { body: '/approve', user: { login: 'carol' } },
      ],
    })

    await approveOnPullRequest(prEvent('synchronize'))

    expect(debug).toHaveBeenCalledWith('approve: the notifier on #1 is up to date')
    await expect(writes.patchComment.notCalled()).resolves.toBe('not called')
    await expect(writes.postComment.notCalled()).resolves.toBe('not called')
  })

  it('a bot comment without the marker is not mistaken for the notifier, and the posted notifier ends with the literal marker', async () => {
    const writes = serve({ comments: [{ id: 900, body: '[APPROVALNOTIFIER] something else entirely', user: bot }, { body: '/approve', user: { login: 'bob' } }] })

    await approveOnPullRequest(prEvent('opened'))

    await expect(writes.postComment.called()).resolves.toBe('called')
    expect((await commentBody(writes.postComment)).endsWith('\n<!-- prow-github-actions/approve -->')).toBe(true)
    await expect(writes.patchComment.notCalled()).resolves.toBe('not called')
  })
})

describe('approveOnReview', () => {
  it('a submitted payload without a review or a pull request fails on the missing pull request, not on the missing review', async () => {
    await expect(approveOnReview(new utils.MockContext({ action: 'submitted' }))).rejects.toThrow('github context payload missing pull request')
  })
})
