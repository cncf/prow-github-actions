import { Octokit } from '@octokit/rest'
import { http } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { assertAuthorizedByOwnersOrMembership } from '../../src/utils/auth'
import issueCommentEvent from '../fixtures/issues/issueCommentEvent.json'
import * as utils from '../testUtils'
import {
  baseSha,
  blobSha,
  changedFiles,
  contentsResponse,
  filesHandler,
  prCommentEvent,
  prHandlers,
  pullHandler,
  repo,
  treeHandlers,
} from './ownersFixtures'

const server = setupServer()
beforeAll(() => {
  utils.setupActionsEnv()
  server.listen({
    onUnhandledRequest: 'error',
  })
})
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

const octokit = new Octokit({ auth: 'some-token' })
const prContext = new utils.MockContext(prCommentEvent('/approve'))

const rootOwners = 'approvers:\n- alice\nreviewers:\n- rita\n'
const sdkOwners = 'approvers:\n- bob\nreviewers:\n- ryan\n'
const olmOwners = 'options:\n  no_parent_owners: true\napprovers:\n- carol\n'

function authorize(role: 'approvers' | 'reviewers', username: string, context = prContext) {
  return assertAuthorizedByOwnersOrMembership(octokit, context, role, username)
}

describe('assertAuthorizedByOwnersOrMembership on a pull request', () => {
  it('lets a root approver approve (parity with a single OWNERS file)', async () => {
    server.use(...prHandlers({ OWNERS: rootOwners }, ['src/file1.txt']))

    await expect(authorize('approvers', 'alice')).resolves.toBeUndefined()
  })

  it('denies a user who is in neither role of the root OWNERS', async () => {
    server.use(...prHandlers({ OWNERS: rootOwners }, ['src/file1.txt']))

    await expect(authorize('approvers', 'rita')).rejects.toThrow(
      'rita is not an approver for src/file1.txt (OWNERS: OWNERS)',
    )
    await expect(authorize('reviewers', 'nobody')).rejects.toThrow(
      'nobody is not a reviewer or approver for any changed file',
    )
  })

  it('inherits approvers from parent directories', async () => {
    const owners = { 'OWNERS': rootOwners, 'sdk/OWNERS': sdkOwners }

    server.use(...prHandlers(owners, ['sdk/x.go']))
    await expect(authorize('approvers', 'alice')).resolves.toBeUndefined()

    server.use(...prHandlers(owners, ['sdk/x.go']))
    await expect(authorize('approvers', 'bob')).resolves.toBeUndefined()
  })

  it('stops inheriting at options.no_parent_owners', async () => {
    const owners = { 'OWNERS': rootOwners, 'olm/OWNERS': olmOwners }

    server.use(...prHandlers(owners, ['olm/y.go']))
    await expect(authorize('approvers', 'alice')).rejects.toThrow(
      'alice is not an approver for olm/y.go (OWNERS: olm/OWNERS)',
    )

    server.use(...prHandlers(owners, ['olm/y.go']))
    await expect(authorize('approvers', 'carol')).resolves.toBeUndefined()
  })

  it('requires an approver to cover every changed file', async () => {
    const owners = { 'OWNERS': rootOwners, 'sdk/OWNERS': sdkOwners, 'olm/OWNERS': olmOwners }
    const files = ['sdk/x.go', 'olm/y.go']

    server.use(...prHandlers(owners, files))
    await expect(authorize('approvers', 'bob')).rejects.toThrow(
      'bob is not an approver for olm/y.go (OWNERS: olm/OWNERS)',
    )

    const both = { ...owners, 'olm/OWNERS': `${olmOwners}- bob\n` }
    server.use(...prHandlers(both, files))
    await expect(authorize('approvers', 'bob')).resolves.toBeUndefined()
  })

  it('lets a reviewer of any changed file lgtm', async () => {
    const owners = { 'OWNERS': rootOwners, 'sdk/OWNERS': sdkOwners, 'olm/OWNERS': olmOwners }
    const files = ['sdk/x.go', 'olm/y.go']

    server.use(...prHandlers(owners, files))
    await expect(authorize('reviewers', 'bob')).resolves.toBeUndefined()

    server.use(...prHandlers(owners, files))
    await expect(authorize('reviewers', 'ryan')).resolves.toBeUndefined()

    server.use(...prHandlers(owners, files))
    await expect(authorize('reviewers', 'nobody')).rejects.toThrow(
      'nobody is not a reviewer or approver for any changed file',
    )
  })

  it('fails closed when a changed file has no covering OWNERS', async () => {
    server.use(...prHandlers({ 'sdk/OWNERS': sdkOwners }, ['README.md']))

    await expect(authorize('approvers', 'bob')).rejects.toThrow(
      'no OWNERS file covers README.md',
    )
  })

  it('falls back to membership when the tree has no OWNERS files', async () => {
    server.use(
      ...prHandlers({}, ['src/file1.txt']),
      http.get(`${utils.api}/orgs/Codertocat/members/alice`, utils.mockResponse(204)),
      http.get(`${repo}/collaborators/alice`, utils.mockResponse(404)),
    )
    await expect(authorize('approvers', 'alice')).resolves.toBeUndefined()

    server.use(
      ...prHandlers({}, ['src/file1.txt']),
      http.get(`${utils.api}/orgs/Codertocat/members/alice`, utils.mockResponse(404)),
      http.get(`${repo}/collaborators/alice`, utils.mockResponse(404)),
    )
    await expect(authorize('approvers', 'alice')).rejects.toThrow(
      'alice is not a org member or collaborator',
    )
  })

  it('reads OWNERS from the base branch, ignoring an OWNERS edited by the PR', async () => {
    const observeContents = new utils.ObserveRequest()
    server.use(
      http.get(`${repo}/contents/OWNERS`, utils.mockResponse(500, null, observeContents)),
      ...prHandlers({ OWNERS: rootOwners }, ['OWNERS', 'src/file1.txt']),
    )

    await expect(authorize('approvers', 'mallory')).rejects.toThrow(
      'mallory is not an approver for OWNERS (OWNERS: OWNERS)',
    )
    await expect(observeContents.notCalled()).resolves.toBe('not called')
  })

  it('compares logins case-insensitively', async () => {
    server.use(...prHandlers({ OWNERS: 'approvers:\n- Alice\n' }, ['src/file1.txt']))

    await expect(authorize('approvers', 'aLICE')).resolves.toBeUndefined()
  })

  it('uses the root OWNERS on an issue without touching pulls or trees', async () => {
    const issueContext = new utils.MockContext(issueCommentEvent)
    const observePull = new utils.ObserveRequest()
    const observeTree = new utils.ObserveRequest()
    server.use(
      http.get(`${repo}/contents/OWNERS`, utils.mockResponse(200, contentsResponse('OWNERS', rootOwners))),
      pullHandler(observePull),
      ...treeHandlers({ OWNERS: rootOwners }, { observeTree }),
    )

    await expect(authorize('approvers', 'alice', issueContext)).resolves.toBeUndefined()
    await expect(observePull.notCalled()).resolves.toBe('not called')
    await expect(observeTree.notCalled()).resolves.toBe('not called')
  })

  it('probes ancestor directories when the tree is truncated', async () => {
    const observeSdk = new utils.ObserveRequest()
    const observeRoot = new utils.ObserveRequest()
    const observeBlob = new utils.ObserveRequest()
    server.use(
      http.get(`${repo}/git/blobs/${blobSha('OWNERS')}`, utils.mockResponse(500, null, observeBlob)),
      http.get(`${repo}/contents/sdk%2FOWNERS`, utils.mockResponse(200, contentsResponse('sdk/OWNERS', sdkOwners), observeSdk)),
      http.get(`${repo}/contents/OWNERS`, utils.mockResponse(200, contentsResponse('OWNERS', rootOwners), observeRoot)),
      pullHandler(),
      filesHandler(changedFiles('sdk/x.go')),
      ...treeHandlers({ 'OWNERS': rootOwners, 'sdk/OWNERS': sdkOwners }, { truncated: true }),
    )

    await expect(authorize('approvers', 'bob')).resolves.toBeUndefined()
    await observeSdk.called()
    await observeRoot.called()
    expect(new URL(observeSdk.ref!.url).searchParams.get('ref')).toBe(baseSha)
    expect(new URL(observeRoot.ref!.url).searchParams.get('ref')).toBe(baseSha)
    await expect(observeBlob.notCalled()).resolves.toBe('not called')
  })

  it('treats a 404 probe as no OWNERS in that directory and fails on other errors', async () => {
    server.use(
      pullHandler(),
      filesHandler(changedFiles('sdk/x.go')),
      ...treeHandlers({}, { truncated: true }),
      http.get(`${repo}/contents/sdk%2FOWNERS`, utils.mockResponse(404)),
      http.get(`${repo}/contents/OWNERS`, utils.mockResponse(200, contentsResponse('OWNERS', rootOwners))),
    )
    await expect(authorize('approvers', 'alice')).resolves.toBeUndefined()

    server.use(
      pullHandler(),
      filesHandler(changedFiles('sdk/x.go')),
      ...treeHandlers({}, { truncated: true }),
      http.get(`${repo}/contents/sdk%2FOWNERS`, utils.mockResponse(500)),
    )
    await expect(authorize('approvers', 'alice')).rejects.toThrow(
      `error loading OWNERS files at ${baseSha}`,
    )
  })

  it('rejects a malformed role', async () => {
    server.use(...prHandlers({ 'OWNERS': rootOwners, 'sdk/OWNERS': 'approvers: alice\n' }, ['sdk/x.go']))

    await expect(authorize('approvers', 'alice')).rejects.toThrow(
      'OWNERS at sdk/OWNERS: approvers must be a list of GitHub usernames',
    )
  })

  it('requires an approver to cover both sides of a rename', async () => {
    const owners = { 'old/OWNERS': 'approvers:\n- olga\n', 'new/OWNERS': 'approvers:\n- nina\n' }
    const rename = { filename: 'new/a.go', previous_filename: 'old/a.go', status: 'renamed' }

    server.use(...prHandlers(owners, [rename]))
    await expect(authorize('approvers', 'nina')).rejects.toThrow(
      'nina is not an approver for old/a.go (OWNERS: old/OWNERS)',
    )

    server.use(...prHandlers({ ...owners, OWNERS: 'approvers:\n- root\n' }, [rename]))
    await expect(authorize('approvers', 'root')).resolves.toBeUndefined()
  })

  it('pages through the changed files', async () => {
    const pages: Record<string, string[]> = {
      1: ['sdk/x.go'],
      2: ['olm/y.go'],
    }
    const seen: string[] = []
    server.use(
      pullHandler(),
      http.get(`${repo}/pulls/1/files`, ({ request }) => {
        const url = new URL(request.url)
        const page = url.searchParams.get('page') ?? '1'
        seen.push(`page=${page}&per_page=${url.searchParams.get('per_page')}`)
        const headers: Record<string, string> = { 'Content-Type': 'application/json' }
        if (page === '1') {
          url.searchParams.set('page', '2')
          headers.Link = `<${url}>; rel="next"`
        }
        return new Response(JSON.stringify(changedFiles(...pages[page])), { status: 200, headers })
      }),
      ...treeHandlers({ 'sdk/OWNERS': sdkOwners, 'olm/OWNERS': olmOwners }),
    )

    await expect(authorize('approvers', 'bob')).rejects.toThrow(
      'bob is not an approver for olm/y.go (OWNERS: olm/OWNERS)',
    )
    expect(seen).toEqual(['page=1&per_page=100', 'page=2&per_page=100'])
  })

  it('fails when the tree cannot be fetched', async () => {
    server.use(
      pullHandler(),
      filesHandler(changedFiles('src/file1.txt')),
      http.get(`${repo}/git/trees/${baseSha}`, utils.mockResponse(500)),
    )

    await expect(authorize('approvers', 'alice')).rejects.toThrow(
      `error loading OWNERS files at ${baseSha}`,
    )
  })

  it('fails when a blob cannot be fetched or is not a file', async () => {
    server.use(
      http.get(`${repo}/git/blobs/${blobSha('OWNERS')}`, utils.mockResponse(500)),
      ...prHandlers({ OWNERS: rootOwners }, ['src/file1.txt']),
    )
    await expect(authorize('approvers', 'alice')).rejects.toThrow(
      `error loading OWNERS files at ${baseSha}`,
    )

    server.use(
      http.get(`${repo}/git/blobs/${blobSha('OWNERS')}`, utils.mockResponse(200, { sha: 'x' })),
      ...prHandlers({ OWNERS: rootOwners }, ['src/file1.txt']),
    )
    await expect(authorize('approvers', 'alice')).rejects.toThrow(
      'invalid OWNERS file returned from GitHub API for OWNERS',
    )
  })

  it('requests the tree recursively and only fetches OWNERS blobs in ancestor directories', async () => {
    const observeTree = new utils.ObserveRequest()
    const observeDocsBlob = new utils.ObserveRequest()
    server.use(
      http.get(`${repo}/git/blobs/${blobSha('docs/OWNERS')}`, utils.mockResponse(500, null, observeDocsBlob)),
      pullHandler(),
      filesHandler(changedFiles('sdk/x.go')),
      ...treeHandlers({ 'OWNERS': rootOwners, 'sdk/OWNERS': sdkOwners, 'docs/OWNERS': 'approvers:\n- doc\n' }, { observeTree }),
    )

    await expect(authorize('approvers', 'bob')).resolves.toBeUndefined()
    await observeTree.called()
    expect(new URL(observeTree.ref!.url).searchParams.get('recursive')).toBe('true')
    await expect(observeDocsBlob.notCalled()).resolves.toBe('not called')
  })
})
