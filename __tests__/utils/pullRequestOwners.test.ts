import * as core from '@actions/core'
import { Octokit } from '@octokit/rest'
import { http } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { loadPullRequestOwners } from '../../src/utils/pullRequestOwners'
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
utils.failTestOnUnhandledRequests(server)
beforeAll(() => server.listen(utils.failOnUnhandledRequest))
beforeEach(() => utils.setupActionsEnv())
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

const octokit = new Octokit({ auth: 'some-token' })
const context = new utils.MockContext(prCommentEvent('/approve'))

// a second repository, to show the memos are keyed by more than the pull number or branch name
const otherRepo = `${utils.api}/repos/Other/Repo`
const otherContext = new utils.MockContext({
  ...prCommentEvent('/approve'),
  repository: { ...prCommentEvent('/approve').repository, name: 'Repo', owner: { login: 'Other' } },
})

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

  it('lists a path once when a rename frees it and another entry reuses it', async () => {
    // `a.go` renamed to `b.go` while a new `a.go` is added: `a.go` is both a previous_filename and a filename
    server.use(...prHandlers(
      { OWNERS: rootOwners },
      [{ filename: 'b.go', previous_filename: 'a.go', status: 'renamed' }, { filename: 'a.go', status: 'added' }],
    ))

    const owners = await loadPullRequestOwners(octokit, context, 1)

    expect(owners.files).toEqual(['b.go', 'a.go'])
    expect(owners.perFile.size).toBe(2)
  })

  it('defaults author, draft, state, reviewers, assignees and labels when the pull omits them', async () => {
    // the shared pullBody sets draft: false, state: 'open' and labels: []; JSON drops undefined, so these are absent
    server.use(...prHandlers({ OWNERS: rootOwners }, ['src/file1.txt'], {
      user: undefined,
      draft: undefined,
      state: undefined,
      requested_reviewers: undefined,
      assignees: undefined,
      labels: undefined,
    }))

    const owners = await loadPullRequestOwners(octokit, context, 1)

    expect(owners).toMatchObject({ author: '', draft: false, open: false, requestedReviewers: [], assignees: [], labels: [] })
  })

  it('reports draft and open only for draft: true and state: open', async () => {
    server.use(...prHandlers({ OWNERS: rootOwners }, ['src/file1.txt'], { draft: true, state: 'open' }))
    const draft = await loadPullRequestOwners(octokit, context, 1)
    expect(draft).toMatchObject({ draft: true, open: true })

    utils.newRun()
    server.use(...prHandlers({ OWNERS: rootOwners }, ['src/file1.txt'], { draft: false, state: 'closed' }))
    const closed = await loadPullRequestOwners(octokit, context, 1)
    expect(closed).toMatchObject({ draft: false, open: false })
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

  it('keys the memo by repository: the same pull number in another repository is fetched again', async () => {
    server.use(...prHandlers({ OWNERS: rootOwners }, ['src/file1.txt']))
    const first = await loadPullRequestOwners(octokit, context, 1)

    const observePull = new utils.ObserveRequest()
    server.use(
      http.get(`${otherRepo}/pulls/1`, utils.mockResponse(200, { base: { ref: baseBranch, sha: baseSha }, head: { sha: 'otherhead' } }, observePull)),
      http.get(`${otherRepo}/pulls/1/files`, utils.mockResponse(200, changedFiles('sdk/x.go'))),
      http.get(`${otherRepo}/branches/${baseBranch}`, utils.mockResponse(200, { name: baseBranch, commit: { sha: baseSha } })),
      http.get(`${otherRepo}/git/trees/${baseSha}`, utils.mockResponse(200, { sha: baseSha, truncated: false, tree: [] })),
    )

    const other = await loadPullRequestOwners(octokit, otherContext, 1)

    await observePull.called()
    expect(other).not.toBe(first)
    expect(other.headSha).toBe('otherhead')
    expect(other.tree.hasOwners).toBe(false)
    expect(first.tree.hasOwners).toBe(true)
  })

  it('a new run fetches afresh', async () => {
    server.use(...prHandlers({ OWNERS: rootOwners }, ['src/file1.txt']))
    const first = await loadPullRequestOwners(octokit, context, 1)

    utils.newRun()
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
      branchHandler(),
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

    it('is keyed by repository: the same branch name in another repository is read again', async () => {
      server.use(...prHandlers({ OWNERS: rootOwners }, ['src/file1.txt']))
      const first = await loadPullRequestOwners(octokit, context, 1)

      const observeBranch = new utils.ObserveRequest()
      server.use(
        http.get(`${otherRepo}/pulls/1`, utils.mockResponse(200, { base: { ref: baseBranch, sha: 'old' }, head: { sha: 'headsha' } })),
        http.get(`${otherRepo}/pulls/1/files`, utils.mockResponse(200, changedFiles('src/file1.txt'))),
        http.get(`${otherRepo}/branches/${baseBranch}`, utils.mockResponse(200, { name: baseBranch, commit: { sha: 'other-tip' } }, observeBranch)),
        http.get(`${otherRepo}/git/trees/other-tip`, utils.mockResponse(200, emptyTree('other-tip'))),
      )

      const other = await loadPullRequestOwners(octokit, otherContext, 1)

      await observeBranch.called()
      expect(first.baseSha).toBe(baseSha)
      expect(other.baseSha).toBe('other-tip')
    })

    it('a new run forgets the tip too', async () => {
      server.use(...prHandlers({ OWNERS: rootOwners }, ['src/file1.txt']))
      await loadPullRequestOwners(octokit, context, 1)

      utils.newRun()
      const observeBranch = new utils.ObserveRequest()
      server.use(pullHandler(), filesHandler(changedFiles('src/file1.txt')), branchHandler(baseSha, baseBranch, observeBranch), ...treeHandlers({ OWNERS: rootOwners }).slice(1))

      await loadPullRequestOwners(octokit, context, 1)

      await observeBranch.called()
    })
  })
})
