import type { FakeGithub } from './fakeGithub'
import { Buffer } from 'node:buffer'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import labelFileContents from '../fixtures/labels/labelFileContentsResp.json'
import { start } from './fakeGithub'
import { configReads, helpersFor, repo, token } from './helpers'
import { runBundle } from './runBundle'

vi.setConfig({ testTimeout: 30_000 })

const labelsRead = `GET ${repo}/labels?per_page=100`

function yamlFile(text: string) {
  const file = structuredClone(labelFileContents)
  file.content = Buffer.from(text).toString('base64')
  return file
}

// the parts of the label catalog that bundle.test.ts' label-sync cases (a `kind` section only) never compose:
// a section outside the command registry, the require_matching_label missing labels and the dedup of a
// missing label two rules spell differently
describe('dist/index.js label-sync catalog', () => {
  let gh: FakeGithub
  const { expectRequests } = helpersFor(() => gh)

  beforeAll(async () => {
    gh = await start()
  })
  afterEach(() => gh.reset())
  afterAll(() => gh.close())

  const builtins = [
    'approved',
    'do-not-merge/hold',
    'good first issue',
    'help wanted',
    'hold',
    'lgtm',
    'lifecycle/frozen',
    'lifecycle/rotten',
    'lifecycle/stale',
    'ok-to-test',
    'stage/alpha',
    'stage/beta',
    'stage/stable',
    'status/approved-for-milestone',
    'status/in-progress',
    'status/in-review',
  ]

  it('creates a custom section as <key>/<value>, one needs-* label per distinct missing_label, in sorted order', async () => {
    const config = yamlFile([
      'labels:',
      '  kind: [bug]',
      '  team:',
      '    - name: docs',
      '      color: 0E8A16',
      '      description: Owned by the docs team',
      'require_matching_label:',
      '  - regexp: ^kind/',
      '    missing_label: needs-kind',
      '    issues: true',
      '  - regexp: ^kind/',
      '    missing_label: Needs-Kind',
      '    prs: true',
      '',
    ].join('\n'))
    gh.route('GET', '/repos/Codertocat/.project/contents/prow.yaml', { status: 200, body: config })
    gh.route('GET', `${repo}/labels`, { status: 200, body: [] })
    gh.route('POST', `${repo}/labels`, { status: 201, body: {} })

    const result = await runBundle({
      eventName: 'workflow_dispatch',
      payload: {},
      inputs: { ...token, jobs: 'label-sync' },
      apiUrl: gh.url,
    })

    expect(result.status, result.stdout).toBe(0)
    expect(result.errors).toEqual([])
    const desired = [...builtins, 'kind/bug', 'needs-kind', 'team/docs'].sort((a, b) => a.localeCompare(b))
    const posts = gh.requestsMatching('POST', /\/labels$/)
    expect(posts.map(p => (p.body as { name: string }).name)).toEqual(desired)
    // the configuration's color is lowercased; a needs-* label gets the catalog's default color and nothing else
    expect(posts.find(p => (p.body as { name: string }).name === 'team/docs')!.body).toEqual({
      name: 'team/docs',
      color: '0e8a16',
      description: 'Owned by the docs team',
    })
    expect(posts.find(p => (p.body as { name: string }).name === 'needs-kind')!.body).toEqual({ name: 'needs-kind', color: 'ededed' })
    expect(posts.find(p => (p.body as { name: string }).name === 'kind/bug')!.body).toEqual({ name: 'kind/bug' })
    expect(result.stdout).toContain(`label-sync: created ${desired.length} [${desired.join(', ')}], updated 0 [], unchanged 0, failed 0`)
    expect(gh.requestsMatching('PATCH', /./)).toEqual([])
    expect(gh.requestsMatching('DELETE', /./)).toEqual([])
    expectRequests([...configReads({ org: '.project' }), labelsRead], desired.map(() => `POST ${repo}/labels`))
  })
})
