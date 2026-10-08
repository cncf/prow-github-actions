import type { FakeGithub } from './fakeGithub'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import pullReqOpenedEvent from '../fixtures/pullReq/pullReqOpenedEvent.json'
import { start } from './fakeGithub'
import { helpersFor, ownersProbe, ownersReads, repo, token } from './helpers'
import { runBundle } from './runBundle'

vi.setConfig({ testTimeout: 30_000 })

// the lgtm job's no-op arm (onPrLgtm.ts: `currentLabels.includes('lgtm')` false), driven through dist/index.js:
// a new push to a pull request that does not carry lgtm reads the labels and removes nothing. bundle.test.ts
// only drives the arm where the label is present and gets removed
describe('dist/index.js pull_request lgtm job on a pull request without the lgtm label', () => {
  let gh: FakeGithub
  const { expectRequests, routeOwners } = helpersFor(() => gh)

  beforeAll(async () => {
    gh = await start()
  })
  afterEach(() => gh.reset())
  afterAll(() => gh.close())

  function synchronize(eventName: string) {
    return runBundle({
      eventName,
      payload: { ...pullReqOpenedEvent, action: 'synchronize' },
      inputs: { ...token, jobs: 'lgtm' },
      apiUrl: gh.url,
    })
  }

  for (const eventName of ['pull_request', 'pull_request_target']) {
    it(`${eventName}: reads the labels and issues no DELETE when lgtm is absent`, async () => {
      routeOwners({}, ['src/file1.txt'])
      gh.route('GET', `${repo}/issues/1`, { status: 200, body: { labels: [{ name: 'kind/bug' }, { name: 'approved' }] } })

      const result = await synchronize(eventName)

      expect(result.status, result.stdout).toBe(0)
      expect(result.errors).toEqual([])
      expect(result.stdout).toContain('remove-lgtm: found labels for issue kind/bug,approved')
      expect(gh.requestsMatching('DELETE', /./)).toEqual([])
      // owners-label reads the (OWNERS-less) base tree, approve probes the default branch, then the lgtm job
      // reads the labels and stops there
      expectRequests([], [
        ...ownersReads,
        ownersProbe,
        `GET ${repo}/issues/1`,
      ])
    })
  }

  it('pull_request: an unlabeled pull request is read and left alone', async () => {
    routeOwners({}, ['src/file1.txt'])
    gh.route('GET', `${repo}/issues/1`, { status: 200, body: { labels: [] } })

    const result = await synchronize('pull_request')

    expect(result.status, result.stdout).toBe(0)
    expect(result.errors).toEqual([])
    expect(result.stdout).toContain('remove-lgtm: found labels for issue ')
    expect(gh.requestsMatching('DELETE', /./)).toEqual([])
    expectRequests([], [...ownersReads, ownersProbe, `GET ${repo}/issues/1`])
  })
})
