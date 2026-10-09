import type { FakeGithub } from './fakeGithub'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import pullReqOpenedEvent from '../fixtures/pullReq/pullReqOpenedEvent.json'
import { start } from './fakeGithub'
import { helpersFor, ownersProbe, ownersReads, repo, token } from './helpers'
import { runBundle } from './runBundle'

vi.setConfig({ testTimeout: 30_000 })

// the arms of handlePullReq's `jobs` input — an unsupported job, and the lgtm job's failed
// labels read — driven through dist/index.js like the happy paths in bundle.test.ts
describe('dist/index.js pull_request jobs input', () => {
  let gh: FakeGithub
  const { calls, routeOwners } = helpersFor(() => gh)

  beforeAll(async () => {
    gh = await start()
  })
  beforeEach(() => {
    gh.mergeQueueFallback({ pullRequestId: 'PR_none', headOid: pullReqOpenedEvent.pull_request.head.sha, enabled: false })
    routeOwners({}, ['src/file1.txt'])
  })
  afterEach(() => gh.reset())
  afterAll(() => gh.close())

  function synchronize(jobs: string) {
    return runBundle({
      eventName: 'pull_request',
      payload: { ...pullReqOpenedEvent, action: 'synchronize' },
      inputs: { ...token, jobs },
      apiUrl: gh.url,
    })
  }

  it('an unsupported job fails the run naming the job after the registered handlers have run', async () => {
    const result = await synchronize('frobnicate')

    expect(result.status, result.stdout).toBe(1)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toContain('could not execute frobnicate')
    // owners-label and approve's probe still run; the unknown job reads nothing
    expect(calls()).toEqual([...ownersReads, ownersProbe])
  })

  it('lgtm job: a failed labels read fails the run and removes nothing', async () => {
    gh.route('GET', `${repo}/issues/1`, { status: 500, body: { message: 'boom' } })

    const result = await synchronize('lgtm')

    expect(result.status, result.stdout).toBe(1)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toContain('TypeError: error handling pull request: Error: could not get labels from issue')
    expect(calls()).toEqual([...ownersReads, ownersProbe, `GET ${repo}/issues/1`])
  })
})
