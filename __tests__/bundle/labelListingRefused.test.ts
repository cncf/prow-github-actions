import type { FakeGithub } from './fakeGithub'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import labelFileContents from '../fixtures/labels/labelFileContentsResp.json'
import { start } from './fakeGithub'
import { comment, configReads, helpersFor, repo, token } from './helpers'
import { runBundle } from './runBundle'

vi.setConfig({ testTimeout: 30_000 })

// the read of the repository's label catalog that both the label commands and the label-sync job make
const labelsRead = `GET ${repo}/labels?per_page=100`

// the `could not list the repository labels` arms: assertLabelsExist (src/utils/labeling.ts, via labelIssue)
// and labelSync (src/cronJobs/labelSync.ts) each wrap the catalog read and rethrow when it fails. Every
// other bundle test routes `GET /labels` to 200, so neither arm was reachable before.
describe('dist/index.js label catalog read refused', () => {
  let gh: FakeGithub
  const { expectRequests } = helpersFor(() => gh)

  beforeAll(async () => {
    gh = await start()
  })
  afterEach(() => gh.reset())
  afterAll(() => gh.close())

  it('/kind fails the run naming the refused label listing and never writes', async () => {
    gh.route('GET', `${repo}/contents/.prowlabels.yaml`, { status: 200, body: labelFileContents })
    gh.route('GET', `${repo}/labels`, { status: 500, body: { message: 'boom' } })

    const result = await runBundle({
      eventName: 'issue_comment',
      payload: comment('/kind cleanup'),
      inputs: { ...token, 'prow-commands': '/kind' },
      apiUrl: gh.url,
    })

    expect(result.status, result.stdout).toBe(1)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toContain('error handling issue comment: Error: could not list the repository labels: HttpError: boom')
    expect(gh.requestsMatching('POST', /./)).toHaveLength(0)
    expectRequests([...configReads({ repo: '.prowlabels.yaml' }), labelsRead], [])
  })

  it('label-sync fails the run naming the refused label listing before planning any write', async () => {
    gh.route('GET', `${repo}/labels`, { status: 500, body: { message: 'boom' } })

    const result = await runBundle({
      eventName: 'workflow_dispatch',
      payload: {},
      inputs: { ...token, jobs: 'label-sync' },
      apiUrl: gh.url,
    })

    expect(result.status, result.stdout).toBe(1)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toContain('error handling cron job: Error: could not list the repository labels: HttpError: boom')
    expect(gh.requestsMatching('POST', /./)).toHaveLength(0)
    expect(gh.requestsMatching('PATCH', /./)).toHaveLength(0)
    expectRequests([...configReads(), labelsRead], [])
  })
})
