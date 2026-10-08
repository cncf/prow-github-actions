import type { FakeGithub } from './fakeGithub'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import labelFileContents from '../fixtures/labels/labelFileContentsResp.json'
import { start } from './fakeGithub'
import { comment, configReads, helpersFor, repo, token } from './helpers'
import { runBundle } from './runBundle'

vi.setConfig({ testTimeout: 30_000 })

// the read every label command makes before it applies a label
const labelsRead = `GET ${repo}/labels?per_page=100`

// labelIssue's refused write: the repository has the label, so assertLabelsExist passes, and the
// `POST /issues/{n}/labels` that follows is answered 500. Driven through dist/index.js like the
// /kind cases in bundle.test.ts, which only route the write to 200.
describe('dist/index.js label write refused', () => {
  let gh: FakeGithub
  const { expectRequests } = helpersFor(() => gh)

  beforeAll(async () => {
    gh = await start()
  })
  afterEach(() => gh.reset())
  afterAll(() => gh.close())

  it('/kind fails the run naming the refused write after one attempt', async () => {
    gh.route('GET', `${repo}/contents/.prowlabels.yaml`, { status: 200, body: labelFileContents })
    gh.route('GET', `${repo}/labels`, { status: 200, body: [{ name: 'kind/cleanup' }] })
    gh.route('POST', `${repo}/issues/1/labels`, { status: 500, body: { message: 'boom' } })

    const result = await runBundle({
      eventName: 'issue_comment',
      payload: comment('/kind cleanup'),
      inputs: { ...token, 'prow-commands': '/kind' },
      apiUrl: gh.url,
    })

    expect(result.status, result.stdout).toBe(1)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toContain('error handling issue comment: Error: could not add labels: HttpError: boom')
    const posts = gh.requestsMatching('POST', /\/issues\/1\/labels$/)
    expect(posts).toHaveLength(1)
    expect(posts[0].body).toEqual({ labels: ['kind/cleanup'] })
    expectRequests([...configReads({ repo: '.prowlabels.yaml' }), labelsRead], [`POST ${repo}/issues/1/labels`])
  })
})
