import * as core from '@actions/core'
import { Octokit } from '@octokit/rest'
import { http } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { branchHasOwners, repoHasOwners, resetOwnersCaches } from '../../src/utils/owners'
import pullReqOpenedEvent from '../fixtures/pullReq/pullReqOpenedEvent.json'
import * as utils from '../testUtils'
import { contentsResponse, repo } from './ownersFixtures'

const server = setupServer()
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

const octokit = new Octokit({ auth: 'some-token' })

// a schedule payload without a repository: the default branch must come from the api
const bareContext = new utils.MockContext({ repository: { owner: { login: 'Codertocat' }, name: 'Hello-World' } })

function treeResponse(paths: string[], truncated = false) {
  return { sha: 'x', truncated, tree: paths.map(path => ({ path, type: 'blob', sha: `blob-${path}` })) }
}

describe('repoHasOwners', () => {
  beforeEach(() => {
    utils.setupActionsEnv()
    resetOwnersCaches()
  })

  it('is true when the default branch tree lists an OWNERS file anywhere', async () => {
    server.use(utils.defaultBranchTree(['README.md', 'sdk/OWNERS']))

    await expect(repoHasOwners(octokit, new utils.MockContext(pullReqOpenedEvent))).resolves.toBe(true)
  })

  it('is false for a tree without OWNERS files and ignores directories named OWNERS', async () => {
    server.use(http.get(`${repo}/git/trees/master`, utils.mockResponse(200, {
      sha: 'x',
      truncated: false,
      tree: [{ path: 'README.md', type: 'blob', sha: 'a' }, { path: 'OWNERS', type: 'tree', sha: 'b' }, { path: 'docs/NOTOWNERS', type: 'blob', sha: 'c' }],
    })))

    await expect(repoHasOwners(octokit, new utils.MockContext(pullReqOpenedEvent))).resolves.toBe(false)
  })

  it('takes the default branch from the payload and requests the tree recursively', async () => {
    const observeTree = new utils.ObserveRequest()
    const observeRepo = new utils.ObserveRequest()
    server.use(
      utils.defaultBranchTree(['OWNERS'], observeTree),
      http.get(repo, utils.mockResponse(200, { default_branch: 'master' }, observeRepo)),
    )

    await expect(repoHasOwners(octokit, new utils.MockContext(pullReqOpenedEvent))).resolves.toBe(true)
    expect(new URL(observeTree.ref!.url).searchParams.get('recursive')).toBe('true')
    await expect(observeRepo.notCalled()).resolves.toBe('not called')
  })

  it('reads the default branch from the api when the payload has no repository', async () => {
    server.use(
      http.get(repo, utils.mockResponse(200, { default_branch: 'trunk' })),
      http.get(`${repo}/git/trees/trunk`, utils.mockResponse(200, treeResponse(['OWNERS']))),
    )

    await expect(repoHasOwners(octokit, bareContext)).resolves.toBe(true)
  })

  it('memoizes the answer per repository for the run', async () => {
    const observeTree = new utils.ObserveRequest()
    let calls = 0
    server.use(http.get(`${repo}/git/trees/master`, async (info) => {
      calls++
      return utils.mockResponse(200, treeResponse(['OWNERS']), observeTree)(info)
    }))
    const context = new utils.MockContext(pullReqOpenedEvent)

    await expect(repoHasOwners(octokit, context)).resolves.toBe(true)
    await expect(repoHasOwners(octokit, context)).resolves.toBe(true)
    expect(calls).toBe(1)
  })

  it('treats a missing tree (empty repository) as no OWNERS files', async () => {
    server.use(http.get(`${repo}/git/trees/master`, utils.mockResponse(404, { message: 'Not Found' })))
    const debug = vi.spyOn(core, 'debug')

    await expect(repoHasOwners(octokit, new utils.MockContext(pullReqOpenedEvent))).resolves.toBe(false)
    expect(debug).toHaveBeenCalledWith('no tree at master: treating the repository as having no OWNERS files')
  })

  it('fails on any other tree error', async () => {
    server.use(http.get(`${repo}/git/trees/master`, utils.mockResponse(500, { message: 'boom' })))

    await expect(repoHasOwners(octokit, new utils.MockContext(pullReqOpenedEvent))).rejects.toThrow('error listing the tree of master')
  })

  it('fails when the default branch cannot be read', async () => {
    server.use(http.get(repo, utils.mockResponse(500, { message: 'boom' })))

    await expect(repoHasOwners(octokit, bareContext)).rejects.toThrow('could not read the default branch')
  })

  it('probes the root OWNERS file when a truncated tree lists none', async () => {
    server.use(
      http.get(`${repo}/git/trees/master`, utils.mockResponse(200, treeResponse(['README.md'], true))),
      http.get(`${repo}/contents/OWNERS`, utils.mockResponse(200, contentsResponse('OWNERS', 'approvers:\n- alice\n'))),
    )
    await expect(repoHasOwners(octokit, new utils.MockContext(pullReqOpenedEvent))).resolves.toBe(true)

    resetOwnersCaches()
    server.use(
      http.get(`${repo}/git/trees/master`, utils.mockResponse(200, treeResponse(['README.md'], true))),
      http.get(`${repo}/contents/OWNERS`, utils.mockResponse(404, { message: 'Not Found' })),
    )
    await expect(repoHasOwners(octokit, new utils.MockContext(pullReqOpenedEvent))).resolves.toBe(false)

    resetOwnersCaches()
    server.use(
      http.get(`${repo}/git/trees/master`, utils.mockResponse(200, treeResponse(['README.md'], true))),
      http.get(`${repo}/contents/OWNERS`, utils.mockResponse(500, { message: 'boom' })),
    )
    await expect(repoHasOwners(octokit, new utils.MockContext(pullReqOpenedEvent))).rejects.toThrow('error probing for a root OWNERS file at master')
  })

  it('does not probe when a truncated tree still lists an OWNERS file', async () => {
    const observeContents = new utils.ObserveRequest()
    server.use(
      http.get(`${repo}/git/trees/master`, utils.mockResponse(200, treeResponse(['OWNERS'], true))),
      http.get(`${repo}/contents/OWNERS`, utils.mockResponse(500, null, observeContents)),
    )

    await expect(repoHasOwners(octokit, new utils.MockContext(pullReqOpenedEvent))).resolves.toBe(true)
    await expect(observeContents.notCalled()).resolves.toBe('not called')
  })
})

describe('branchHasOwners', () => {
  beforeEach(() => {
    utils.setupActionsEnv()
    resetOwnersCaches()
  })

  it('reads the tree of the given branch, not the default one', async () => {
    const observeDefault = new utils.ObserveRequest()
    server.use(
      utils.defaultBranchTree([], observeDefault),
      http.get(`${repo}/git/trees/release-1`, utils.mockResponse(200, treeResponse(['sdk/OWNERS']))),
    )

    await expect(branchHasOwners(octokit, new utils.MockContext(pullReqOpenedEvent), 'release-1')).resolves.toBe(true)
    await expect(observeDefault.notCalled()).resolves.toBe('not called')
  })

  it('is false for a branch without OWNERS files while the default branch has them', async () => {
    server.use(
      utils.defaultBranchTree(['OWNERS']),
      http.get(`${repo}/git/trees/release-1`, utils.mockResponse(200, treeResponse(['README.md']))),
    )
    const context = new utils.MockContext(pullReqOpenedEvent)

    await expect(branchHasOwners(octokit, context, 'release-1')).resolves.toBe(false)
    await expect(repoHasOwners(octokit, context)).resolves.toBe(true)
  })

  it('memoizes per branch and shares the default branch with repoHasOwners', async () => {
    let trees = 0
    server.use(http.get(`${repo}/git/trees/:branch`, ({ params }) => {
      trees++
      return new Response(JSON.stringify(treeResponse(params.branch === 'master' ? ['OWNERS'] : [])), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }))
    const context = new utils.MockContext(pullReqOpenedEvent)

    await expect(repoHasOwners(octokit, context)).resolves.toBe(true)
    await expect(branchHasOwners(octokit, context, 'master')).resolves.toBe(true)
    await expect(branchHasOwners(octokit, context, 'release-1')).resolves.toBe(false)
    await expect(branchHasOwners(octokit, context, 'release-1')).resolves.toBe(false)
    expect(trees).toBe(2)
  })
})
