import type { FakeGithub } from './fakeGithub'
import { Buffer } from 'node:buffer'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import labelFileContents from '../fixtures/labels/labelFileContentsResp.json'
import { start } from './fakeGithub'
import { comment, configReads, helpersFor, repo, token } from './helpers'
import { runBundle } from './runBundle'

vi.setConfig({ testTimeout: 30_000 })

function yamlFile(text: string) {
  const file = structuredClone(labelFileContents)
  file.content = Buffer.from(text).toString('base64')
  return file
}

// a prefixed command whose section is present but lists no value: normalizeSection accepts
// `kind: []`, so every argument is outside the allowlist and the refusal names `allowed: none`
// (src/labels/prefixed.ts:251) instead of an empty list
describe('dist/index.js prefixed label command against an empty allowlist', () => {
  let gh: FakeGithub
  const { expectRequests } = helpersFor(() => gh)

  beforeAll(async () => {
    gh = await start()
  })
  afterEach(() => gh.reset())
  afterAll(() => gh.close())

  function run(body: string, commands: string) {
    return runBundle({ eventName: 'issue_comment', payload: comment(body), inputs: { ...token, 'prow-commands': commands }, apiUrl: gh.url })
  }

  it('/kind with a plain empty list fails naming "allowed: none", without reading or writing labels', async () => {
    gh.route('GET', `${repo}/contents/.prowlabels.yaml`, { status: 200, body: yamlFile('kind: []\n') })

    const result = await run('/kind cleanup', '/kind')

    expect(result.status, result.stdout).toBe(1)
    expect(result.errors.some(e => e.includes('kind: no allowed value in "cleanup"; allowed: none'))).toBe(true)
    expectRequests(configReads({ repo: '.prowlabels.yaml' }), [])
  })

  it('/kind with an empty `values` mapping fails the same way', async () => {
    gh.route('GET', `${repo}/contents/.prowlabels.yaml`, { status: 200, body: yamlFile('kind:\n  values: []\n  exclusive: true\n') })

    const result = await run('/kind cleanup bug', '/kind')

    expect(result.status, result.stdout).toBe(1)
    expect(result.errors.some(e => e.includes('kind: no allowed value in "cleanup bug"; allowed: none'))).toBe(true)
    expectRequests(configReads({ repo: '.prowlabels.yaml' }), [])
  })
})
