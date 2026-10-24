import type { Octokit } from '@octokit/rest'
import * as core from '@actions/core'
import { Octokit as RealOctokit } from '@octokit/rest'
import { http } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  branchHasOwners,
  expandGroups,
  loadOwnersTree,
  parseGroup,
  parseOwners,
  repoHasOwners,
  resetOwnersCaches,
} from '../../src/utils/owners'
import * as utils from '../testUtils'
import { repo } from './ownersFixtures'

// Each test here pins a contract of src/utils/owners.ts that a mutation of the
// source survived under the rest of the suite: a bare `options:` key, the
// per-team group cache key, parseGroup's leading anchor, decode's
// missing-content error, the repository-less payload fallback of
// defaultBranch, isNotFound on a string or null rejection, the path-less tree
// entry guard and the per-repository OWNERS-presence cache key.

const server = setupServer()
beforeAll(() => server.listen(utils.failOnUnhandledRequest))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

const octokit = new RealOctokit({ auth: 'some-token' })

function treeResponse(entries: Array<{ path?: string, type: string, sha: string }>, truncated = false) {
  return { sha: 'x', truncated, tree: entries }
}

describe('parseOwners', () => {
  it('treats a bare options key (yaml null) as no options', () => {
    expect(parseOwners('OWNERS', 'options:\napprovers:\n- alice\n')).toMatchObject({ approvers: ['alice'], noParentOwners: false })
  })
})

describe('expandGroups', () => {
  const context = { repo: { owner: 'MyOrg', repo: 'r' } } as never

  function client(listed: Record<string, string[]>) {
    const paginate = vi.fn(async (_fn: unknown, params: { team_slug: string }) => {
      const members = listed[params.team_slug]
      if (members === undefined) {
        throw new Error('404')
      }
      return members.map(login => ({ login }))
    })
    return { paginate, teams: { listMembersInOrg: vi.fn() } } as never
  }

  beforeEach(() => resetOwnersCaches())

  it('reads each of two same-org teams separately: the second does not reuse the first team\'s members', async () => {
    const api = client({ approvers: ['alice'], reviewers: ['bob'] })

    const result = await expandGroups(api, context, ['@myorg/approvers', '@myorg/reviewers'])

    expect([...result].sort()).toEqual(['alice', 'bob'])
    expect((api as { paginate: ReturnType<typeof vi.fn> }).paginate).toHaveBeenCalledTimes(2)
  })

  it('keeps an entry with an @ in the middle as a plain login and reads no team', async () => {
    const api = client({ team: ['bob'] })

    const result = await expandGroups(api, context, ['alice@myorg/team'])

    expect([...result]).toEqual(['alice@myorg/team'])
    expect((api as { paginate: ReturnType<typeof vi.fn> }).paginate).not.toHaveBeenCalled()
    expect(parseGroup('alice@myorg/team')).toBeUndefined()
  })

  it('names the group and the supported organization when ignoring a group of another organization', async () => {
    await expandGroups(client({}), context, ['@other/team'])

    expect(core.warning).toHaveBeenCalledTimes(1)
    expect(core.warning).toHaveBeenCalledWith('OWNERS: ignoring group @other/team: only groups of myorg are supported')
  })
})

describe('loadOwnersTree', () => {
  const context = new utils.MockContext({ repository: { owner: { login: 'Codertocat' }, name: 'Hello-World' } })

  beforeEach(() => {
    utils.setupActionsEnv()
    resetOwnersCaches()
  })

  it('rejects a blob that names an encoding but carries no content as an invalid OWNERS file', async () => {
    server.use(
      http.get(`${repo}/git/trees/base-sha`, utils.mockResponse(200, treeResponse([{ path: 'OWNERS', type: 'blob', sha: 'blob-owners' }]))),
      http.get(`${repo}/git/blobs/blob-owners`, utils.mockResponse(200, { sha: 'blob-owners', encoding: 'base64' })),
    )

    await expect(loadOwnersTree(octokit, context, 'base-sha', ['README.md'])).rejects.toThrow(
      'error loading OWNERS files at base-sha: Error: invalid OWNERS file returned from GitHub API for OWNERS',
    )
  })
})

describe('repoHasOwners', () => {
  beforeEach(() => {
    utils.setupActionsEnv()
    resetOwnersCaches()
  })

  it('reads the default branch from the api when the payload has no repository at all', async () => {
    // a schedule payload: context.repo comes from the runner's GITHUB_REPOSITORY, not the payload
    process.env.GITHUB_REPOSITORY = 'Codertocat/Hello-World'
    const observeRepo = new utils.ObserveRequest()
    server.use(
      http.get(repo, utils.mockResponse(200, { default_branch: 'trunk' }, observeRepo)),
      http.get(`${repo}/git/trees/trunk`, utils.mockResponse(200, treeResponse([{ path: 'OWNERS', type: 'blob', sha: 'a' }]))),
    )

    await expect(repoHasOwners(octokit, new utils.MockContext({}))).resolves.toBe(true)
    expect(observeRepo.ref).not.toBeNull()
  })

  it('memoizes per repository: a second repository without OWNERS files is not answered from the first', async () => {
    const other = `${utils.api}/repos/Codertocat/Other`
    server.use(
      utils.defaultBranchTree(['OWNERS']),
      http.get(other, utils.mockResponse(200, { default_branch: 'main' })),
      http.get(`${other}/git/trees/main`, utils.mockResponse(200, treeResponse([{ path: 'README.md', type: 'blob', sha: 'a' }]))),
    )
    const first = new utils.MockContext({ repository: { owner: { login: 'Codertocat' }, name: 'Hello-World', default_branch: 'master' } })
    const second = new utils.MockContext({ repository: { owner: { login: 'Codertocat' }, name: 'Other' } })

    await expect(repoHasOwners(octokit, first)).resolves.toBe(true)
    await expect(repoHasOwners(octokit, second)).resolves.toBe(false)
  })
})

describe('branchHasOwners', () => {
  beforeEach(() => {
    utils.setupActionsEnv()
    resetOwnersCaches()
  })

  it.each([
    ['boom', 'a string'],
    [null, 'null'],
  ])('reports a tree rejection of %j (%s) as a listing error, not as a missing tree', async (reason) => {
    // Octokit itself always rejects with a RequestError; the guard is what keeps a
    // bare rejection from being mistaken for a 404 (or from throwing on `in`)
    const bare = { git: { getTree: vi.fn().mockRejectedValue(reason) } } as unknown as Octokit
    const context = new utils.MockContext({ repository: { owner: { login: 'Codertocat' }, name: 'Hello-World' } })

    await expect(branchHasOwners(bare, context, 'main')).rejects.toThrow(`error listing the tree of main: ${reason}`)
  })

  it('skips a tree entry without a path and still finds the OWNERS file after it', async () => {
    server.use(
      http.get(`${repo}/git/trees/main`, utils.mockResponse(200, treeResponse([
        { type: 'blob', sha: 'no-path' },
        { path: 'OWNERS', type: 'blob', sha: 'b' },
      ]))),
    )
    const context = new utils.MockContext({ repository: { owner: { login: 'Codertocat' }, name: 'Hello-World' } })

    await expect(branchHasOwners(octokit, context, 'main')).resolves.toBe(true)
  })
})
