import * as core from '@actions/core'
import { Octokit } from '@octokit/rest'
import { http } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { loadPullRequestOwners, resetPullRequestOwnersCache } from '../../src/utils/pullRequestOwners'
import * as utils from '../testUtils'
import {
  baseBranch,
  baseSha,
  blobSha,
  branchHandler,
  changedFiles,
  filesHandler,
  prCommentEvent,
  prHandlers,
  pullHandler,
  repo,
  treeHandlers,
} from './ownersFixtures'

const server = setupServer()
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
beforeEach(() => utils.setupActionsEnv())
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

const octokit = new Octokit({ auth: 'some-token' })
const context = new utils.MockContext(prCommentEvent('/approve'))

const rootOwners = 'approvers:\n- alice\nreviewers:\n- rita\nlabels:\n- kind/root\n'
const sdkOwners = 'approvers:\n- bob\nreviewers:\n- ryan\nlabels:\n- area/sdk\n'

describe('loadPullRequestOwners', () => {
  it('reads the pull request, its files and the OWNERS of the base branch in that order', async () => {
    const observePull = new utils.ObserveRequest()
    const observeFiles = new utils.ObserveRequest()
    const observeTree = new utils.ObserveRequest()
    const order: string[] = []
    server.use(
      http.get(`${repo}/pulls/1`, async (info) => {
        order.push('pull')
        return utils.mockResponse(200, {
          base: { ref: baseBranch, sha: baseSha },
          head: { sha: 'headsha' },
          user: { login: 'Some-Author' },
          draft: true,
          requested_reviewers: [{ login: 'Rita' }],
          assignees: [{ login: 'Al' }],
          labels: [{ name: 'kind/bug' }, { name: 'Approved' }],
        }, observePull)(info)
      }),
      http.get(`${repo}/pulls/1/files`, async (info) => {
        order.push('files')
        return utils.mockResponse(200, changedFiles('sdk/x.go', 'docs/y.md'), observeFiles)(info)
      }),
      ...treeHandlers({ 'OWNERS': rootOwners, 'sdk/OWNERS': sdkOwners }, { observeTree }),
    )

    const owners = await loadPullRequestOwners(octokit, context, 1)

    expect(order).toEqual(['pull', 'files'])
    await observeTree.called()
    expect(owners).toMatchObject({
      number: 1,
      baseSha,
      author: 'some-author',
      draft: true,
      requestedReviewers: ['rita'],
      assignees: ['al'],
      labels: ['kind/bug', 'Approved'],
      files: ['sdk/x.go', 'docs/y.md'],
    })
    expect(owners.tree.hasOwners).toBe(true)
    expect([...owners.perFile.get('sdk/x.go')!.reviewers]).toEqual(['ryan', 'rita'])
    expect([...owners.perFile.get('sdk/x.go')!.labels]).toEqual(['area/sdk', 'kind/root'])
    expect(owners.perFile.get('sdk/x.go')!.sources).toEqual(['sdk/OWNERS', 'OWNERS'])
    expect(owners.perFile.get('docs/y.md')!.sources).toEqual(['OWNERS'])
  })

  it('counts both sides of a rename once each and marks uncovered files undefined', async () => {
    server.use(...prHandlers(
      { 'new/OWNERS': 'approvers:\n- nina\n' },
      [{ filename: 'new/a.go', previous_filename: 'old/a.go', status: 'renamed' }, 'new/b.go'],
    ))

    const owners = await loadPullRequestOwners(octokit, context, 1)

    expect(owners.files).toEqual(['new/a.go', 'old/a.go', 'new/b.go'])
    expect(owners.perFile.get('old/a.go')).toBeUndefined()
    expect([...owners.perFile.get('new/a.go')!.approvers]).toEqual(['nina'])
    expect(owners.perFile.has('old/a.go')).toBe(true)
  })

  it('defaults author, draft, reviewers, assignees and labels when the pull omits them', async () => {
    server.use(...prHandlers({ OWNERS: rootOwners }, ['src/file1.txt']))

    const owners = await loadPullRequestOwners(octokit, context, 1)

    expect(owners).toMatchObject({ author: '', draft: false, requestedReviewers: [], assignees: [], labels: [] })
  })

  it('memoizes per pull request: a second call in the same run makes no requests', async () => {
    server.use(...prHandlers({ OWNERS: rootOwners }, ['src/file1.txt']))
    const first = await loadPullRequestOwners(octokit, context, 1)

    const observePull = new utils.ObserveRequest()
    const observeFiles = new utils.ObserveRequest()
    const observeTree = new utils.ObserveRequest()
    server.use(
      pullHandler(observePull),
      filesHandler(changedFiles('other.txt'), observeFiles),
      ...treeHandlers({}, { observeTree }),
    )

    const second = await loadPullRequestOwners(octokit, context, 1)

    expect(second).toBe(first)
    await expect(observePull.notCalled()).resolves.toBe('not called')
    await expect(observeFiles.notCalled()).resolves.toBe('not called')
    await expect(observeTree.notCalled()).resolves.toBe('not called')
  })

  it('shares one in-flight fetch between concurrent callers', async () => {
    let pulls = 0
    server.use(
      http.get(`${repo}/pulls/1`, () => {
        pulls++
        return new Response(JSON.stringify({ base: { ref: baseBranch, sha: baseSha }, head: { sha: 'headsha' } }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }),
      filesHandler(changedFiles('src/file1.txt')),
      ...treeHandlers({ OWNERS: rootOwners }),
    )

    const [a, b] = await Promise.all([
      loadPullRequestOwners(octokit, context, 1),
      loadPullRequestOwners(octokit, context, 1),
    ])

    expect(a).toBe(b)
    expect(pulls).toBe(1)
  })

  it('keys the memo by pull number', async () => {
    server.use(...prHandlers({ OWNERS: rootOwners }, ['src/file1.txt']))
    await loadPullRequestOwners(octokit, context, 1)

    const observePull = new utils.ObserveRequest()
    server.use(
      http.get(`${repo}/pulls/2`, utils.mockResponse(200, { base: { ref: baseBranch, sha: baseSha }, head: { sha: 'headsha' } }, observePull)),
      http.get(`${repo}/pulls/2/files`, utils.mockResponse(200, changedFiles('sdk/x.go'))),
      ...treeHandlers({ OWNERS: rootOwners }),
    )

    const other = await loadPullRequestOwners(octokit, context, 2)

    await observePull.called()
    expect(other.number).toBe(2)
  })

  it('resetPullRequestOwnersCache forces a fresh fetch', async () => {
    server.use(...prHandlers({ OWNERS: rootOwners }, ['src/file1.txt']))
    const first = await loadPullRequestOwners(octokit, context, 1)

    resetPullRequestOwnersCache()
    const observePull = new utils.ObserveRequest()
    server.use(pullHandler(observePull), filesHandler(changedFiles('src/file1.txt')), ...treeHandlers({ OWNERS: rootOwners }))

    const second = await loadPullRequestOwners(octokit, context, 1)

    await observePull.called()
    expect(second).not.toBe(first)
  })

  it('propagates OWNERS load errors and requests the tree at the base sha', async () => {
    const observeTree = new utils.ObserveRequest()
    server.use(
      pullHandler(),
      filesHandler(changedFiles('src/file1.txt')),
      http.get(`${repo}/git/trees/${baseSha}`, utils.mockResponse(500, null, observeTree)),
      http.get(`${repo}/git/blobs/${blobSha('OWNERS')}`, utils.mockResponse(500)),
    )

    await expect(loadPullRequestOwners(octokit, context, 1)).rejects.toThrow(`error loading OWNERS files at ${baseSha}`)
    await observeTree.called()
  })

  describe('the base branch tip', () => {
    const emptyTree = (sha: string) => ({ sha, truncated: false, tree: [] })

    it('reads the OWNERS at the current tip of the base branch, not at base.sha (cncf/automation#709)', async () => {
      const observeOld = new utils.ObserveRequest()
      server.use(
        pullHandler(undefined, { base: { ref: baseBranch, sha: 'old' } }),
        filesHandler(changedFiles('src/file1.txt')),
        http.get(`${repo}/git/trees/old`, utils.mockResponse(200, emptyTree('old'), observeOld)),
        ...treeHandlers({ OWNERS: rootOwners }, { sha: 'new' }),
      )

      const owners = await loadPullRequestOwners(octokit, context, 1)

      expect(owners.baseSha).toBe('new')
      expect(owners.tree.hasOwners).toBe(true)
      expect([...owners.perFile.get('src/file1.txt')!.approvers]).toEqual(['alice'])
      await expect(observeOld.notCalled()).resolves.toBe('not called')
    })

    it('a pull request whose base lost its OWNERS files sees none', async () => {
      server.use(
        pullHandler(undefined, { base: { ref: baseBranch, sha: 'old' } }),
        filesHandler(changedFiles('src/file1.txt')),
        ...treeHandlers({ OWNERS: rootOwners }, { sha: 'old' }).slice(1),
        ...treeHandlers({}, { sha: 'new' }),
      )

      const owners = await loadPullRequestOwners(octokit, context, 1)

      expect(owners.baseSha).toBe('new')
      expect(owners.tree.hasOwners).toBe(false)
      expect(owners.perFile.get('src/file1.txt')).toBeUndefined()
    })

    it('falls back to base.sha with a warning when the base branch cannot be read', async () => {
      const warning = vi.spyOn(core, 'warning').mockImplementation(() => {})
      server.use(
        pullHandler(),
        filesHandler(changedFiles('src/file1.txt')),
        http.get(`${repo}/branches/${baseBranch}`, utils.mockResponse(404, { message: 'Branch not found' })),
        ...treeHandlers({ OWNERS: rootOwners }).slice(1),
      )

      const owners = await loadPullRequestOwners(octokit, context, 1)

      expect(owners.baseSha).toBe(baseSha)
      expect(owners.tree.hasOwners).toBe(true)
      expect(warning).toHaveBeenCalledWith(expect.stringContaining(`could not read the tip of ${baseBranch}; reading OWNERS at ${baseSha}`))
    })

    it('is memoized per branch: two pull requests on the same base cost one branch read and one tree read', async () => {
      let branches = 0
      let trees = 0
      const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
      server.use(
        http.get(`${repo}/pulls/:number`, ({ params }) => json({ number: Number(params.number), base: { ref: baseBranch, sha: 'old' }, head: { sha: 'headsha' } })),
        http.get(`${repo}/pulls/:number/files`, utils.mockResponse(200, changedFiles('src/file1.txt'))),
        http.get(`${repo}/branches/${baseBranch}`, () => {
          branches++
          return json({ name: baseBranch, commit: { sha: 'new' } })
        }),
        http.get(`${repo}/git/trees/new`, () => {
          trees++
          return json(emptyTree('new'))
        }),
      )

      const [one, two] = await Promise.all([loadPullRequestOwners(octokit, context, 1), loadPullRequestOwners(octokit, context, 2)])

      expect(one.baseSha).toBe('new')
      expect(two.baseSha).toBe('new')
      expect(branches).toBe(1)
      expect(trees).toBe(1)
    })

    it('resetPullRequestOwnersCache forgets the tip too', async () => {
      server.use(...prHandlers({ OWNERS: rootOwners }, ['src/file1.txt']))
      await loadPullRequestOwners(octokit, context, 1)

      resetPullRequestOwnersCache()
      const observeBranch = new utils.ObserveRequest()
      server.use(pullHandler(), filesHandler(changedFiles('src/file1.txt')), branchHandler(baseSha, baseBranch, observeBranch), ...treeHandlers({ OWNERS: rootOwners }).slice(1))

      await loadPullRequestOwners(octokit, context, 1)

      await observeBranch.called()
    })
  })
})
