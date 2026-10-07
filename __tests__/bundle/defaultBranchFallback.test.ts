import type { FakeGithub } from './fakeGithub'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import pullReqListPulls from '../fixtures/pullReq/pullReqListPulls.json'
import pullReqOpenedEvent from '../fixtures/pullReq/pullReqOpenedEvent.json'
import { start } from './fakeGithub'
import { configReads, helpersFor, ownersProbe, ownersReads, queueRead, repo, token } from './helpers'
import { runBundle } from './runBundle'

vi.setConfig({ testTimeout: 30_000 })

// the `repos.get` read `defaultBranch` falls back to when the payload names no `repository.default_branch`
const repoRead = `GET ${repo}`
const head = pullReqOpenedEvent.pull_request.head.sha

// the pull_request payload with the base branch's name removed: `approve` then asks `repoHasOwners`
// for the default branch instead of `branchHasOwners` for `base.ref`
function withoutBaseRef(payload: typeof pullReqOpenedEvent) {
  const { ref: _ref, ...base } = payload.pull_request.base
  return { ...payload, pull_request: { ...payload.pull_request, base } }
}

// the same payload with `repository.default_branch` removed too, so the name has to come from the api
function withoutDefaultBranch<T extends { repository: typeof pullReqOpenedEvent.repository }>(payload: T) {
  const { default_branch: _default, ...repository } = payload.repository
  return { ...payload, repository }
}

describe('dist/index.js: the default branch stands in when no base branch is in scope', () => {
  let gh: FakeGithub
  const { expectRequests, routeOwners } = helpersFor(() => gh)

  beforeAll(async () => {
    gh = await start()
  })
  beforeEach(() => gh.mergeQueueFallback({ pullRequestId: 'PR_none', headOid: head, enabled: false }))
  afterEach(() => gh.reset())
  afterAll(() => gh.close())

  describe('approve on a pull_request payload without base.ref (approve.ts evaluateOnOwnersRepo → owners.ts repoHasOwners)', () => {
    const synchronize = (payload: unknown) => runBundle({ eventName: 'pull_request', payload, inputs: token, apiUrl: gh.url })

    it('probes the tree of repository.default_branch without a repos.get read', async () => {
      routeOwners({}, ['src/file1.txt'])

      const result = await synchronize({ ...withoutBaseRef(pullReqOpenedEvent), action: 'synchronize' })

      expect(result.status, result.stdout).toBe(0)
      expect(result.errors).toEqual([])
      expect(result.stdout).toContain('approve: the base branch has no OWNERS files')
      // owners-label's reads, then approve's probe of master (the payload's default branch); tide skips synchronize
      expect(gh.requests.map(r => `${r.method} ${r.path}`)).toEqual([...ownersReads, ownersProbe])
    })

    it('reads the default branch from repos.get when the payload names none, then probes that tree', async () => {
      routeOwners({}, ['src/file1.txt'])
      gh.route('GET', repo, { status: 200, body: { default_branch: 'trunk' } })

      const result = await synchronize({ ...withoutDefaultBranch(withoutBaseRef(pullReqOpenedEvent)), action: 'synchronize' })

      expect(result.status, result.stdout).toBe(0)
      expect(result.errors).toEqual([])
      expect(result.stdout).toContain('approve: the base branch has no OWNERS files')
      expect(gh.requests.map(r => `${r.method} ${r.path}`)).toEqual([...ownersReads, repoRead, `GET ${repo}/git/trees/trunk?recursive=true`])
    })

    it('fails the run when repos.get answers 500, probing no tree', async () => {
      routeOwners({}, ['src/file1.txt'])
      gh.route('GET', repo, { status: 500, body: { message: 'boom' } })

      const result = await synchronize({ ...withoutDefaultBranch(withoutBaseRef(pullReqOpenedEvent)), action: 'synchronize' })

      expect(result.status, result.stdout).toBe(1)
      expect(result.errors).toHaveLength(1)
      expect(result.errors[0]).toContain('could not read the default branch')
      // owners-label still lists the tree at the base sha; approve probes no branch tree
      expect(gh.requestsMatching('GET', /\/git\/trees\/(?!basesha)/)).toEqual([])
      expect(gh.requests.map(r => `${r.method} ${r.path}`)).toEqual([...ownersReads, repoRead])
    })
  })

  describe('tide gate on a pull request whose api read carries no base.ref (tide.ts loadTide → owners.ts repoHasOwners)', () => {
    const pullRead = `GET ${repo}/pulls/1`
    const bind = `POST ${repo}/statuses/${head}`
    const bindingRead = `GET ${repo}/commits/${head}/status?per_page=100`
    const merge = `PUT ${repo}/pulls/1/merge`

    function cleanPrWithoutBaseRef() {
      const pr = structuredClone(pullReqListPulls[0])
      const { ref: _ref, ...base } = pr.base
      return { ...pr, base, labels: [{ name: 'lgtm' }], number: 1, mergeable: true, mergeable_state: 'clean', head: { sha: head } }
    }

    function labeledLgtm(payload: Record<string, unknown> = pullReqOpenedEvent) {
      return { ...payload, action: 'labeled', label: { name: 'lgtm' }, sender: pullReqOpenedEvent.sender }
    }

    const run = (payload: unknown) => runBundle({ eventName: 'pull_request', payload, inputs: { ...token, 'merge-method': 'squash' }, apiUrl: gh.url })

    it('probes the tree of repository.default_branch and merges', async () => {
      gh.commitStatuses(repo, head, [{ context: 'prow/lgtm', state: 'success' }])
      gh.route('GET', `${repo}/pulls/1`, { status: 200, body: cleanPrWithoutBaseRef() })
      gh.route('PUT', `${repo}/pulls/1/merge`, { status: 200, body: { merged: true } })

      const result = await run(labeledLgtm())

      expect(result.status, result.stdout).toBe(0)
      expect(result.errors).toEqual([])
      expect(result.stdout).toContain('merged pr #1')
      expectRequests(configReads(), [bind, pullRead, ownersProbe, bindingRead, queueRead, merge])
    })

    it('reads the default branch from repos.get when the payload names none, probes that tree and merges', async () => {
      gh.commitStatuses(repo, head, [{ context: 'prow/lgtm', state: 'success' }])
      gh.route('GET', `${repo}/pulls/1`, { status: 200, body: cleanPrWithoutBaseRef() })
      gh.route('GET', repo, { status: 200, body: { default_branch: 'trunk' } })
      gh.route('PUT', `${repo}/pulls/1/merge`, { status: 200, body: { merged: true } })

      const result = await run(labeledLgtm(withoutDefaultBranch(pullReqOpenedEvent)))

      expect(result.status, result.stdout).toBe(0)
      expect(result.errors).toEqual([])
      expect(result.stdout).toContain('merged pr #1')
      expectRequests(configReads(), [bind, pullRead, repoRead, `GET ${repo}/git/trees/trunk?recursive=true`, bindingRead, queueRead, merge])
    })

    it('fails the merge when repos.get answers 500, probing no tree', async () => {
      gh.commitStatuses(repo, head, [{ context: 'prow/lgtm', state: 'success' }])
      gh.route('GET', `${repo}/pulls/1`, { status: 200, body: cleanPrWithoutBaseRef() })
      gh.route('GET', repo, { status: 500, body: { message: 'boom' } })

      const result = await run(labeledLgtm(withoutDefaultBranch(pullReqOpenedEvent)))

      expect(result.status, result.stdout).toBe(1)
      expect(result.errors).toHaveLength(1)
      expect(result.errors[0]).toContain('could not read the default branch')
      expect(gh.requestsMatching('GET', /\/git\/trees\//)).toEqual([])
      expect(gh.requestsMatching('PUT', /./)).toEqual([])
      expectRequests(configReads(), [bind, pullRead, repoRead])
    })
  })
})
