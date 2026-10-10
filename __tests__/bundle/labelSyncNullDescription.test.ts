import type { FakeGithub } from './fakeGithub'
import { Buffer } from 'node:buffer'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import labelFileContents from '../fixtures/labels/labelFileContentsResp.json'
import { start } from './fakeGithub'
import { configReads, helpersFor, repo, token } from './helpers'
import { runBundle } from './runBundle'

vi.setConfig({ testTimeout: 30_000 })

const labelsRead = `GET ${repo}/labels?per_page=100`

// the `current.description ?? ''` arm of labelSync's drift (labelSync.ts:133): the REST api returns
// `description: null` for a label that was created without one. bundle.test.ts and
// labelSyncFailureArms.test.ts only ever list labels whose description is a string, so the null
// shape never reaches the bundle: it must read as "no description", so a configured description
// is patched in and an empty configured description leaves the label alone
describe('dist/index.js label-sync with a null label description', () => {
  let gh: FakeGithub
  const { expectRequests } = helpersFor(() => gh)

  beforeAll(async () => {
    gh = await start()
  })
  afterEach(() => gh.reset())
  afterAll(() => gh.close())

  const orgConfig = {
    ...structuredClone(labelFileContents),
    content: Buffer.from([
      'labels:',
      '  kind:',
      '    - name: bug',
      '      color: d73a4a',
      '      description: Something is not working',
      '    - name: cleanup',
      '      color: c5def5',
      '      description: ""',
      '',
    ].join('\n')).toString('base64'),
  }

  const builtins = ['approved', 'do-not-merge/hold', 'good first issue', 'help wanted', 'hold', 'lgtm', 'lifecycle/frozen', 'lifecycle/rotten', 'lifecycle/stale', 'ok-to-test', 'stage/alpha', 'stage/beta', 'stage/stable', 'status/approved-for-milestone', 'status/in-progress', 'status/in-review']

  it('patches a configured description onto a label the api lists with description null, and counts a null one whose configured description is empty as unchanged', async () => {
    gh.route('GET', '/repos/Codertocat/.project/contents/prow.yaml', { status: 200, body: orgConfig })
    gh.route('GET', `${repo}/labels`, {
      status: 200,
      body: [
        { name: 'kind/bug', color: 'd73a4a', description: null },
        { name: 'kind/cleanup', color: 'c5def5', description: null },
      ],
    })
    gh.route('POST', `${repo}/labels`, { status: 201, body: {} })
    gh.route('PATCH', `${repo}/labels/kind%2Fbug`, { status: 200, body: {} })

    const result = await runBundle({
      eventName: 'workflow_dispatch',
      payload: {},
      inputs: { ...token, jobs: 'label-sync' },
      apiUrl: gh.url,
    })

    expect(result.status, result.stdout).toBe(0)
    expect(result.errors).toEqual([])
    expect(result.stdout).toContain(`label-sync: created ${builtins.length} [${builtins.join(', ')}], updated 1 [kind/bug], unchanged 1, failed 0`)

    const posts = gh.requestsMatching('POST', /\/labels$/)
    expect(posts.map(p => (p.body as { name: string }).name)).toEqual(builtins)
    // the description alone is patched: the color already matches
    const patches = gh.requestsMatching('PATCH', /./)
    expect(patches).toHaveLength(1)
    expect(patches[0].path).toBe(`${repo}/labels/kind%2Fbug`)
    expect(patches[0].body).toEqual({ description: 'Something is not working' })
    expect(gh.requestsMatching('DELETE', /./)).toEqual([])
    expectRequests(
      [...configReads({ org: '.project' }), labelsRead],
      [...builtins, 'kind/bug'].sort((a, b) => a.localeCompare(b)).map(name => (name === 'kind/bug' ? `PATCH ${repo}/labels/kind%2Fbug` : `POST ${repo}/labels`)),
    )
  })
})
