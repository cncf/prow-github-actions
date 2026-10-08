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

// the catalog's verbatim arm (labelCatalog.ts `prefixed('', value)`), driven through dist/index.js: the `/label`
// allowlist is the `labels.labels` section and its values are created as-is, never as `labels/<value>`.
// labelSyncCatalog.test.ts only composes prefixed sections (kind, a custom key) and needs-* labels
describe('dist/index.js label-sync creates the /label allowlist verbatim', () => {
  let gh: FakeGithub
  const { expectRequests } = helpersFor(() => gh)

  beforeAll(async () => {
    gh = await start()
  })
  afterEach(() => gh.reset())
  afterAll(() => gh.close())

  function runLabelSync() {
    return runBundle({ eventName: 'workflow_dispatch', payload: {}, inputs: { ...token, jobs: 'label-sync' }, apiUrl: gh.url })
  }

  it('a labels.labels section yields the bare names, with color and description carried over', async () => {
    const config = yamlFile([
      'labels:',
      '  labels:',
      '    - documentation',
      '    - name: tide/merge-method-squash',
      '      color: FEF2C0',
      '      description: Squash when merging',
      '',
    ].join('\n'))
    gh.route('GET', '/repos/Codertocat/.project/contents/prow.yaml', { status: 200, body: config })
    gh.route('GET', `${repo}/labels`, { status: 200, body: [] })
    gh.route('POST', `${repo}/labels`, { status: 201, body: {} })

    const result = await runLabelSync()

    expect(result.status, result.stdout).toBe(0)
    expect(result.errors).toEqual([])
    const posts = gh.requestsMatching('POST', /\/labels$/)
    const created = posts.map(p => (p.body as { name: string }).name)
    expect(created).toContain('documentation')
    expect(created).toContain('tide/merge-method-squash')
    expect(created.filter(name => name.startsWith('labels/'))).toEqual([])
    expect(posts.find(p => (p.body as { name: string }).name === 'documentation')!.body).toEqual({ name: 'documentation' })
    expect(posts.find(p => (p.body as { name: string }).name === 'tide/merge-method-squash')!.body).toEqual({
      name: 'tide/merge-method-squash',
      color: 'fef2c0',
      description: 'Squash when merging',
    })
    expect(result.stdout).toContain(`label-sync: created ${created.length} [${created.join(', ')}]`)
    expectRequests([...configReads({ org: '.project' }), labelsRead], created.map(() => `POST ${repo}/labels`))
  })
})
