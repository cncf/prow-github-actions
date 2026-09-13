import * as core from '@actions/core'
import { http } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { ownersLabel } from '../../src/plugins/ownersLabel'
import { handlePullReq } from '../../src/pullReq/handlePullReq'
import pullReqOpenedEvent from '../fixtures/pullReq/pullReqOpenedEvent.json'
import * as utils from '../testUtils'
import { baseSha, changedFiles, filesHandler, prHandlers, pullHandler, repo, treeHandlers } from '../utils/ownersFixtures'

const server = setupServer()
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

const rootOwners = 'approvers:\n- alice\nlabels:\n- kind/root\n'
const sdkOwners = 'reviewers:\n- bob\nlabels:\n- area/sdk\n- Area/Shared\n'
const olmOwners = 'options:\n  no_parent_owners: true\nreviewers:\n- carol\nlabels:\n- area/olm\n'
const owners = { 'OWNERS': rootOwners, 'sdk/OWNERS': sdkOwners, 'olm/OWNERS': olmOwners }

function prEvent(action: string) {
  return new utils.MockContext({ ...structuredClone(pullReqOpenedEvent), action })
}

interface Reads {
  issue: utils.ObserveRequest
  repoLabels: utils.ObserveRequest
  addLabels: utils.ObserveRequest
}

function serveIssue(current: string[], repoLabels: string[]): Reads {
  const reads: Reads = {
    issue: new utils.ObserveRequest(),
    repoLabels: new utils.ObserveRequest(),
    addLabels: new utils.ObserveRequest(),
  }
  server.use(
    http.get(`${repo}/issues/1`, utils.mockResponse(200, { labels: current.map(name => ({ name })) }, reads.issue)),
    utils.repoHasLabels(repoLabels, reads.repoLabels),
    http.post(`${repo}/issues/1/labels`, utils.mockResponse(200, [], reads.addLabels)),
  )
  return reads
}

async function addedLabels(reads: Reads): Promise<string[]> {
  await reads.addLabels.called()
  const body = await reads.addLabels.body() as { labels: string[] }
  return [...body.labels].sort()
}

describe('ownersLabel', () => {
  let info: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    utils.setupActionsEnv()
    info = vi.spyOn(core, 'info').mockImplementation(() => {})
  })

  it('opened: adds the union of the labels declared along the OWNERS walk of every changed file', async () => {
    server.use(...prHandlers(owners, ['sdk/x.go', 'olm/y.go']))
    const reads = serveIssue([], ['kind/root', 'area/sdk', 'area/shared', 'area/olm'])

    await ownersLabel(prEvent('opened'))

    expect(await addedLabels(reads)).toEqual(['Area/Shared', 'area/olm', 'area/sdk', 'kind/root'])
    expect(info).not.toHaveBeenCalled()
  })

  it.each(['reopened', 'synchronize'])('%s: adds the missing labels', async (action) => {
    server.use(...prHandlers({ 'sdk/OWNERS': sdkOwners }, ['sdk/x.go']))
    const reads = serveIssue([], ['area/sdk', 'area/shared'])

    await ownersLabel(prEvent(action))

    expect(await addedLabels(reads)).toEqual(['Area/Shared', 'area/sdk'])
  })

  it('skips labels already on the pull request, compared case-insensitively, and posts nothing when none is missing', async () => {
    server.use(...prHandlers({ 'sdk/OWNERS': sdkOwners }, ['sdk/x.go']))
    const reads = serveIssue(['AREA/SDK', 'area/shared'], ['area/sdk', 'area/shared'])

    await ownersLabel(prEvent('opened'))

    await expect(reads.addLabels.notCalled()).resolves.toBe('not called')
    expect(reads.repoLabels.ref).toBeNull()
  })

  it('adds only the missing label when some are already present', async () => {
    server.use(...prHandlers({ 'sdk/OWNERS': sdkOwners }, ['sdk/x.go']))
    const reads = serveIssue(['area/sdk'], ['area/sdk', 'area/shared'])

    await ownersLabel(prEvent('opened'))

    expect(await addedLabels(reads)).toEqual(['Area/Shared'])
  })

  it('logs and skips a label the repository does not have, still adding the rest', async () => {
    server.use(...prHandlers({ 'sdk/OWNERS': sdkOwners }, ['sdk/x.go']))
    const reads = serveIssue([], ['area/sdk'])

    await expect(ownersLabel(prEvent('opened'))).resolves.toBeUndefined()

    expect(await addedLabels(reads)).toEqual(['area/sdk'])
    expect(info).toHaveBeenCalledExactlyOnceWith(
      `owners-label: skipping label Area/Shared declared in OWNERS: repository doesn't have it (run label-sync)`,
    )
  })

  it('posts nothing when every missing label is absent from the repository', async () => {
    server.use(...prHandlers({ 'sdk/OWNERS': sdkOwners }, ['sdk/x.go']))
    const reads = serveIssue([], ['unrelated'])

    await ownersLabel(prEvent('opened'))

    await expect(reads.addLabels.notCalled()).resolves.toBe('not called')
    expect(info).toHaveBeenCalledTimes(2)
  })

  it('does nothing beyond the OWNERS reads when no covering OWNERS declares labels', async () => {
    server.use(...prHandlers({ OWNERS: 'approvers:\n- alice\n' }, ['src/file1.txt']))
    const reads = serveIssue([], ['kind/root'])

    await ownersLabel(prEvent('opened'))

    await expect(reads.addLabels.notCalled()).resolves.toBe('not called')
    expect(reads.issue.ref).toBeNull()
    expect(reads.repoLabels.ref).toBeNull()
  })

  it('ignores labels of OWNERS files that cover none of the changed files', async () => {
    server.use(...prHandlers(owners, ['docs/readme.md']))
    const reads = serveIssue([], ['kind/root', 'area/sdk', 'area/olm'])

    await ownersLabel(prEvent('opened'))

    expect(await addedLabels(reads)).toEqual(['kind/root'])
  })

  it('does nothing at all when the repository has no OWNERS files', async () => {
    server.use(...prHandlers({}, ['src/file1.txt']))
    const reads = serveIssue([], [])

    await ownersLabel(prEvent('opened'))

    await expect(reads.addLabels.notCalled()).resolves.toBe('not called')
    expect(reads.issue.ref).toBeNull()
  })

  it.each(['labeled', 'unlabeled', 'edited', 'closed', 'ready_for_review'])('%s: skips without calling the api', async (action) => {
    const debug = vi.spyOn(core, 'debug').mockImplementation(() => {})
    const observePull = new utils.ObserveRequest()
    server.use(pullHandler(observePull))

    await ownersLabel(prEvent(action))

    expect(debug).toHaveBeenCalledWith(`owners-label: skipping ${action} action`)
    await expect(observePull.notCalled()).resolves.toBe('not called')
  })

  it('reads OWNERS from the base sha of the pull request', async () => {
    const observeTree = new utils.ObserveRequest()
    server.use(
      pullHandler(),
      filesHandler(changedFiles('sdk/x.go')),
      ...treeHandlers({ 'sdk/OWNERS': sdkOwners }, { observeTree }),
    )
    serveIssue([], ['area/sdk', 'area/shared'])

    await ownersLabel(prEvent('opened'))

    await observeTree.called()
    expect(new URL(observeTree.ref!.url).pathname).toBe(`/repos/Codertocat/Hello-World/git/trees/${baseSha}`)
  })

  it('fails when the pull request cannot be read', async () => {
    server.use(http.get(`${repo}/pulls/1`, utils.mockResponse(500, { message: 'boom' })))

    await expect(ownersLabel(prEvent('opened'))).rejects.toThrow(/boom/)
  })

  it('fails when the labels cannot be added', async () => {
    server.use(...prHandlers({ 'sdk/OWNERS': sdkOwners }, ['sdk/x.go']))
    serveIssue([], ['area/sdk', 'area/shared'])
    server.use(http.post(`${repo}/issues/1/labels`, utils.mockResponse(500, { message: 'boom' })))

    await expect(ownersLabel(prEvent('opened'))).rejects.toThrow(/could not add labels: .*boom/)
  })

  it('fails without a pull request in the payload', async () => {
    await expect(ownersLabel(new utils.MockContext({ action: 'opened' }))).rejects.toThrow(
      'github context payload missing pull request',
    )
  })

  it('is registered on the pull_request event and runs next to the lgtm job', async () => {
    utils.setupJobsEnv('lgtm')
    const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})
    server.use(
      ...utils.noOrgOrRepoConfigExcept(),
      ...prHandlers({ 'sdk/OWNERS': sdkOwners }, ['sdk/x.go']),
      http.delete(`${repo}/issues/1/labels/lgtm`, utils.mockResponse(200, [])),
    )
    const reads = serveIssue(['lgtm'], ['area/sdk', 'area/shared'])

    await handlePullReq(prEvent('synchronize'))

    expect(await addedLabels(reads)).toEqual(['Area/Shared', 'area/sdk'])
    expect(setFailed).not.toHaveBeenCalled()
  })

  it('surfaces its error through the pull_request event aggregation', async () => {
    utils.setupJobsEnv('')
    const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})
    server.use(
      ...utils.noOrgOrRepoConfigExcept(),
      http.get(`${repo}/pulls/1`, utils.mockResponse(500, { message: 'boom' })),
    )

    await handlePullReq(prEvent('opened'))

    expect(setFailed).toHaveBeenCalledExactlyOnceWith(expect.stringMatching(/^error handling pull_request event: .*boom/))
  })
})
