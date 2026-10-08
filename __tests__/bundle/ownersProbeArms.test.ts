import type { FakeGithub } from './fakeGithub'
import { Buffer } from 'node:buffer'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { blobSha, prCommentEvent, pullBody } from '../utils/ownersFixtures'
import { start } from './fakeGithub'
import { helpersFor, ownersProbe, ownersReads, queueRead, repo, token } from './helpers'
import { runBundle } from './runBundle'

vi.setConfig({ testTimeout: 30_000 })

// the arms of src/utils/owners.ts that a recursive tree listing does not settle, driven through dist/index.js by
// `/approve` on a pull request: the OWNERS plugins' per-path probe when the base tip's tree is truncated (probeOwners),
// and the tide gate's probe of the base branch when its tree has no OWNERS blob, is truncated or cannot be listed
// (probeBranchOwners)
describe('dist/index.js OWNERS probes', () => {
  let gh: FakeGithub
  const { calls, expectCommandThenConfig, routeOwners } = helpersFor(() => gh)

  const rootOwners = 'approvers:\n- bob\n'
  const rootOwnersRead = `GET ${repo}/contents/OWNERS?ref=basesha`
  const sdkOwnersRead = `GET ${repo}/contents/sdk%2FOWNERS?ref=basesha`
  const baseProbe = `GET ${repo}/contents/OWNERS?ref=master`
  const lgtmBindingRead = `GET ${repo}/commits/headsha/status?per_page=100`
  const merge = `PUT ${repo}/pulls/1/merge`

  // the approve evaluation's reads after the OWNERS files, then its writes for an approving `/approve` by bob
  const approval = [
    `GET ${repo}/issues/1/comments?per_page=100`,
    `GET ${repo}/pulls/1/reviews?per_page=100`,
    `GET ${repo}/labels?per_page=100`,
    `POST ${repo}/issues/1/labels`,
    `POST ${repo}/issues/1/comments`,
  ]

  beforeAll(async () => {
    gh = await start()
  })
  afterEach(() => gh.reset())
  afterAll(() => gh.close())

  function contents(text: string) {
    return { status: 200, body: { encoding: 'base64', content: Buffer.from(text).toString('base64') } }
  }

  // `/approve` by bob on a pull request touching sdk/ only, with `labels` on the pull request as tide re-reads it
  function routeApprove(labels: string[] = []) {
    gh.route('GET', `${repo}/pulls/1`, { status: 200, body: { ...pullBody, user: { login: 'Codertocat' }, requested_reviewers: [], assignees: [], labels: labels.map(name => ({ name })) } })
    routeOwners({ OWNERS: rootOwners }, ['sdk/x.go'])
    gh.route('GET', `${repo}/issues/1/comments`, { status: 200, body: [{ id: 1, body: '/approve', user: { login: 'bob', type: 'User' }, created_at: '2024-01-01T00:00:01Z' }] })
    gh.route('GET', `${repo}/pulls/1/reviews`, { status: 200, body: [] })
    gh.route('GET', `${repo}/labels`, { status: 200, body: [{ name: 'approved' }, { name: 'lgtm' }] })
    gh.route('POST', `${repo}/issues/1/labels`, { status: 200, body: [] })
    gh.route('POST', `${repo}/issues/1/comments`, { status: 201, body: {} })
    gh.commitStatuses(repo, 'headsha', [{ context: 'prow/lgtm', state: 'success' }])
    gh.route('PUT', `${repo}/pulls/1/merge`, { status: 200, body: { merged: true } })
  }

  function runApprove() {
    return runBundle({
      eventName: 'issue_comment',
      payload: prCommentEvent('/approve', 'bob'),
      inputs: { ...token, 'prow-commands': '/approve' },
      apiUrl: gh.url,
    })
  }

  describe('the base tip\'s tree is truncated: every candidate OWNERS path is read directly', () => {
    function routeTruncatedBase() {
      // the first matching route wins, so the truncated listing goes in before routeOwners' complete one
      gh.route('GET', `${repo}/git/trees/basesha`, { status: 200, body: { sha: 'basesha', truncated: true, tree: [] } })
    }

    it('root OWNERS present, sdk/OWNERS absent: bob approves from the root file; no blob is read', async () => {
      routeTruncatedBase()
      gh.route('GET', `${repo}/contents/OWNERS`, contents(rootOwners))
      routeApprove(['lgtm'])
      gh.route('GET', `${repo}/git/trees/master`, { status: 200, body: { sha: 'master', truncated: false, tree: [{ path: 'OWNERS', type: 'blob', sha: 'o' }] } })

      const result = await runApprove()

      expect(result.status, result.stdout).toBe(0)
      expect(result.errors).toEqual([])
      expect(result.stdout).toContain('approve: #1 is approved by bob')
      expect(gh.requestsMatching('POST', /\/issues\/1\/labels$/).map(r => r.body)).toEqual([{ labels: ['approved'] }])
      expect(gh.requestsMatching('GET', /\/git\/blobs\//)).toEqual([])
      // the root is probed first, then the changed file's directory, one at a time
      expectCommandThenConfig([...ownersReads, rootOwnersRead, sdkOwnersRead], [
        ...approval,
        `GET ${repo}/pulls/1`,
        ownersProbe,
        queueRead,
      ])
      expect(result.stdout).toContain('skipping pr #1: missing approved')
    })

    it('a probe that fails other than 404 fails /approve naming the base tip; nothing is written', async () => {
      routeTruncatedBase()
      gh.route('GET', `${repo}/contents/OWNERS`, contents(rootOwners))
      gh.route('GET', `${repo}/contents/sdk%2FOWNERS`, { status: 500, body: { message: 'boom' } })
      routeApprove()

      const result = await runApprove()

      expect(result.status, result.stdout).toBe(1)
      expect(result.errors.some(e => e.includes('error loading OWNERS files at basesha'))).toBe(true)
      expect(gh.requestsMatching('POST', /\/issues\/1\//)).toEqual([])
      expect(gh.requestsMatching('GET', /\/git\/blobs\//)).toEqual([])
      expect(calls().slice(0, ownersReads.length + 2)).toEqual([...ownersReads, rootOwnersRead, sdkOwnersRead])
    })
  })

  describe('the tide gate\'s probe of the base branch', () => {
    it('a complete tree without an OWNERS blob: the gate wants lgtm alone and the pull request merges', async () => {
      routeApprove(['lgtm'])
      gh.route('GET', `${repo}/git/trees/master`, { status: 200, body: { sha: 'master', truncated: false, tree: [{ path: 'README.md', type: 'blob', sha: 'r' }] } })

      const result = await runApprove()

      expect(result.status, result.stdout).toBe(0)
      expect(result.errors).toEqual([])
      expect(result.stdout).not.toContain('skipping pr #1')
      expect(gh.requestsMatching('GET', /\/contents\/OWNERS/)).toEqual([])
      expectCommandThenConfig([...ownersReads, `GET ${repo}/git/blobs/${blobSha('OWNERS')}`], [
        ...approval,
        `GET ${repo}/pulls/1`,
        ownersProbe,
        lgtmBindingRead,
        queueRead,
        merge,
      ])
    })

    it('a truncated tree without an OWNERS blob and a root OWNERS file: the gate wants approved too', async () => {
      routeApprove(['lgtm'])
      gh.route('GET', `${repo}/git/trees/master`, { status: 200, body: { sha: 'master', truncated: true, tree: [{ path: 'README.md', type: 'blob', sha: 'r' }] } })
      gh.route('GET', `${repo}/contents/OWNERS`, contents(rootOwners))

      const result = await runApprove()

      expect(result.status, result.stdout).toBe(0)
      expect(result.errors).toEqual([])
      expect(result.stdout).toContain('skipping pr #1: missing approved')
      expect(gh.requestsMatching('PUT', /./)).toEqual([])
      expectCommandThenConfig([...ownersReads, `GET ${repo}/git/blobs/${blobSha('OWNERS')}`], [
        ...approval,
        `GET ${repo}/pulls/1`,
        ownersProbe,
        baseProbe,
        queueRead,
      ])
    })

    it('a truncated tree without an OWNERS blob and no root OWNERS file: the gate wants lgtm alone', async () => {
      routeApprove(['lgtm'])
      gh.route('GET', `${repo}/git/trees/master`, { status: 200, body: { sha: 'master', truncated: true, tree: [{ path: 'README.md', type: 'blob', sha: 'r' }] } })

      const result = await runApprove()

      expect(result.status, result.stdout).toBe(0)
      expect(result.errors).toEqual([])
      expect(result.stdout).not.toContain('skipping pr #1')
      expectCommandThenConfig([...ownersReads, `GET ${repo}/git/blobs/${blobSha('OWNERS')}`], [
        ...approval,
        `GET ${repo}/pulls/1`,
        ownersProbe,
        baseProbe,
        lgtmBindingRead,
        queueRead,
        merge,
      ])
    })

    it('a truncated tree whose root OWNERS probe fails other than 404: the merge fails naming the branch', async () => {
      routeApprove(['lgtm'])
      gh.route('GET', `${repo}/git/trees/master`, { status: 200, body: { sha: 'master', truncated: true, tree: [] } })
      gh.route('GET', `${repo}/contents/OWNERS`, { status: 500, body: { message: 'boom' } })

      const result = await runApprove()

      expect(result.status, result.stdout).toBe(1)
      expect(result.errors.some(e => e.includes('error probing for a root OWNERS file at master'))).toBe(true)
      expect(gh.requestsMatching('PUT', /./)).toEqual([])
      expect(calls().slice(-2)).toEqual([ownersProbe, baseProbe])
    })

    it('a tree listing that fails other than 404: the merge fails naming the branch; no root probe', async () => {
      routeApprove(['lgtm'])
      gh.route('GET', `${repo}/git/trees/master`, { status: 500, body: { message: 'boom' } })

      const result = await runApprove()

      expect(result.status, result.stdout).toBe(1)
      expect(result.errors.some(e => e.includes('error listing the tree of master'))).toBe(true)
      expect(gh.requestsMatching('GET', /\/contents\/OWNERS/)).toEqual([])
      expect(gh.requestsMatching('PUT', /./)).toEqual([])
      expect(calls().slice(-1)).toEqual([ownersProbe])
    })
  })
})
