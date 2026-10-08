import type { FakeGithub } from './fakeGithub'
import { Buffer } from 'node:buffer'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import labelFileContents from '../fixtures/labels/labelFileContentsResp.json'
import { start } from './fakeGithub'
import { comment, configReads, helpersFor, repo, repoLabels, token } from './helpers'
import { runBundle } from './runBundle'

vi.setConfig({ testTimeout: 30_000 })

const issueRead = `GET ${repo}/issues/1`
const labelsRead = `GET ${repo}/labels?per_page=100`
const labelWrite = `POST ${repo}/issues/1/labels`

function yamlFile(text: string) {
  const file = structuredClone(labelFileContents)
  file.content = Buffer.from(text).toString('base64')
  return file
}

// the empty-document arm of parseProwConfig (src/utils/config.ts: `loaded === undefined || loaded === null` ->
// `{}`), driven through dist/index.js: a .github/prow.yaml that is blank, comment-only or a bare document
// marker is a found configuration source with no sections, which is not the same as having no file at all
describe('dist/index.js with an empty .github/prow.yaml', () => {
  let gh: FakeGithub
  const { expectRequests } = helpersFor(() => gh)

  beforeAll(async () => {
    gh = await start()
  })
  afterEach(() => gh.reset())
  afterAll(() => gh.close())

  function run(yaml: string, body: string, command: string) {
    gh.route('GET', `${repo}/contents/.github%2Fprow.yaml`, { status: 200, body: yamlFile(yaml) })
    gh.route('GET', `${repo}/issues/1`, { status: 200, body: { labels: [] } })
    gh.route('GET', `${repo}/labels`, repoLabels('lifecycle/stale', 'kind/cleanup'))
    gh.route('POST', `${repo}/issues/1/labels`, { status: 200, body: [] })
    return runBundle({
      eventName: 'issue_comment',
      payload: comment(body),
      inputs: { ...token, 'prow-commands': command },
      apiUrl: gh.url,
    })
  }

  // a comment-only file belongs here too, but js-yaml 5 throws on zero-document input and the loader's
  // `trim()` guard does not catch it (issue #393); add that row once parseProwConfig handles it
  const emptyDocuments: [string, string][] = [
    ['a blank file', ''],
    ['a bare document marker', '---\n'],
  ]

  it.each(emptyDocuments)('%s stops the repository tier search and serves /lifecycle from the built-in defaults', async (_name, yaml) => {
    const result = await run(yaml, '/lifecycle stale', '/lifecycle')

    expect(result.status, result.stdout).toBe(0)
    expect(result.errors).toEqual([])
    expect(result.stdout).toContain('lifecycle: using built-in labels frozen,stale,rotten')
    expect(gh.requestsMatching('POST', /\/issues\/1\/labels$/).map(r => r.body)).toEqual([{ labels: ['lifecycle/stale'] }])
    // the empty file is a found source: the loader reads no further repository path and never reports "no prow configuration found"
    expectRequests(configReads({ repo: '.github/prow.yaml' }), [issueRead, labelsRead, labelWrite])
  })

  it.each(emptyDocuments)('%s is a found source without a kind section: /kind fails naming the missing key, not a missing configuration', async (_name, yaml) => {
    const result = await run(yaml, '/kind cleanup', '/kind')

    expect(result.status, result.stdout).toBe(1)
    expect(result.errors.some(e => e.includes(`kind: yaml malformed, expected 'kind' top level key`)), result.stdout).toBe(true)
    expect(result.errors.some(e => e.includes('no prow configuration found'))).toBe(false)
    expect(gh.requestsMatching('POST', /\/issues\/1\/labels$/)).toEqual([])
  })
})
