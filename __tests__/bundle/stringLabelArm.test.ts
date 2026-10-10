import type { FakeGithub } from './fakeGithub'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import labelFileContents from '../fixtures/labels/labelFileContentsResp.json'
import { start } from './fakeGithub'
import { comment, configReads, helpersFor, repo, token } from './helpers'
import { runBundle } from './runBundle'

vi.setConfig({ testTimeout: 30_000 })

// the issue schema types `labels` as `(string | { name?: string, … })[]`: getCurrentLabels
// (src/utils/labeling.ts:144-149) passes a bare string through and reads an object's name, falling
// back to '' when it has none. bundle.test.ts only ever serves `{ name }` objects, so the string
// arm and the nameless-object fallback are reached here, through dist/index.js
describe('dist/index.js getCurrentLabels label-shape arms', () => {
  let gh: FakeGithub
  const { expectRequests } = helpersFor(() => gh)

  beforeAll(async () => {
    gh = await start()
  })
  afterEach(() => gh.reset())
  afterAll(() => gh.close())

  it('issue_comment /remove-kind matches a label the api returns as a bare string and skips a nameless object', async () => {
    gh.route('GET', `${repo}/contents/.prowlabels.yaml`, { status: 200, body: labelFileContents })
    gh.route('GET', `${repo}/issues/1`, { status: 200, body: { labels: ['kind/cleanup', { id: 2 }, { name: 'needs-kind' }] } })
    gh.route('DELETE', `${repo}/issues/1/labels/kind%2Fcleanup`, { status: 200, body: [] })

    const result = await runBundle({
      eventName: 'issue_comment',
      payload: comment('/remove-kind cleanup'),
      inputs: { ...token, 'prow-commands': '/kind' },
      apiUrl: gh.url,
    })

    expect(result.status, result.stdout).toBe(0)
    expect(result.errors).toEqual([])
    expect(result.stdout).toContain('kind: found labels for issue kind/cleanup,,needs-kind')
    expect(gh.requestsMatching('POST', /./)).toEqual([])
    expectRequests(configReads({ repo: '.prowlabels.yaml' }), [
      `GET ${repo}/issues/1`,
      `DELETE ${repo}/issues/1/labels/kind%2Fcleanup`,
    ])
  })
})
