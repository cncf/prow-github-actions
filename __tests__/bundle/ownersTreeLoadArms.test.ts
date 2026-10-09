import type { FakeGithub } from './fakeGithub'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { blobSha, prCommentEvent } from '../utils/ownersFixtures'
import { start } from './fakeGithub'
import { helpersFor, ownersProbe, ownersReads, queueRead, repo, token } from './helpers'
import { runBundle } from './runBundle'

vi.setConfig({ testTimeout: 30_000 })

// the failure arms of the complete-tree OWNERS loader in src/utils/owners.ts (loadOwnersTree), driven through
// dist/index.js by `/approve` on a pull request: the recursive tree listing of the base tip cannot be read, or an
// OWNERS blob answers without content to decode. Each fails the run naming the base tip before anything is written.
// The truncated-tree probes live in ownersProbeArms.test.ts (#320).
describe('dist/index.js OWNERS tree loading failures', () => {
  let gh: FakeGithub
  const { expectCommandThenConfig, routeOwners } = helpersFor(() => gh)

  const rootOwners = 'approvers:\n- bob\n'
  const rootBlobRead = `GET ${repo}/git/blobs/${blobSha('OWNERS')}`

  beforeAll(async () => {
    gh = await start()
  })
  afterEach(() => gh.reset())
  afterAll(() => gh.close())

  function runApprove() {
    return runBundle({
      eventName: 'issue_comment',
      payload: prCommentEvent('/approve', 'bob'),
      inputs: { ...token, 'prow-commands': '/approve' },
      apiUrl: gh.url,
    })
  }

  // the failed command, then the post-command sweep's config reads, then tide's own reads of the pull request
  // and the base branch before its merge-queue dequeue; nothing is written
  function expectFailedLoad(result: Awaited<ReturnType<typeof runBundle>>, command: string[]) {
    expect(result.status, result.stdout).toBe(1)
    expect(result.errors.some(e => e.includes('error loading OWNERS files at basesha'))).toBe(true)
    expect(gh.requestsMatching('POST', /\/issues\//)).toEqual([])
    expect(gh.requestsMatching('PUT', /./)).toEqual([])
    expect(gh.requestsMatching('GET', /\/contents\/OWNERS/)).toEqual([])
    expectCommandThenConfig(command, [`GET ${repo}/pulls/1`, ownersProbe, queueRead])
  }

  it('a tree listing that fails other than 404: /approve fails naming the base tip; no blob is read', async () => {
    // the first matching route wins, so the failing listing goes in before routeOwners' complete one
    gh.route('GET', `${repo}/git/trees/basesha`, { status: 500, body: { message: 'boom' } })
    routeOwners({ OWNERS: rootOwners }, ['sdk/x.go'])

    const result = await runApprove()

    expectFailedLoad(result, ownersReads)
    expect(gh.requestsMatching('GET', /\/git\/blobs\//)).toEqual([])
  })

  it('an OWNERS blob answering without content: /approve fails naming the file and the base tip', async () => {
    gh.route('GET', `${repo}/git/blobs/${blobSha('OWNERS')}`, { status: 200, body: { sha: blobSha('OWNERS'), size: 0 } })
    routeOwners({ OWNERS: rootOwners }, ['sdk/x.go'])

    const result = await runApprove()

    expectFailedLoad(result, [...ownersReads, rootBlobRead])
    expect(result.errors.some(e => e.includes('invalid OWNERS file returned from GitHub API for OWNERS'))).toBe(true)
  })
})
