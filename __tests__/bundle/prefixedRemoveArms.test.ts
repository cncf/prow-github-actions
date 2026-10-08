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

// the arms of the prefixed label commands (src/labels/prefixed.ts) and of plain /remove (src/labels/remove.ts)
// that bundle.test.ts, labelCommands and the dispatcher suites leave out, driven through dist/index.js
describe('dist/index.js prefixed label and /remove arms', () => {
  let gh: FakeGithub
  const { expectCommandThenConfig, expectRequests } = helpersFor(() => gh)

  beforeAll(async () => {
    gh = await start()
  })
  afterEach(() => gh.reset())
  afterAll(() => gh.close())

  function run(body: string, commands: string) {
    return runBundle({ eventName: 'issue_comment', payload: comment(body), inputs: { ...token, 'prow-commands': commands }, apiUrl: gh.url })
  }

  it('/kind fails naming the missing section when the configuration has no kind key and the command has no built-in defaults', async () => {
    gh.route('GET', `${repo}/contents/.prowlabels.yaml`, { status: 200, body: yamlFile('area:\n  - bug\n') })

    const result = await run('/kind cleanup', '/kind')

    expect(result.status, result.stdout).toBe(1)
    expect(result.errors.some(e => e.includes(`could not get labels from yaml: Error: kind: yaml malformed, expected 'kind' top level key`))).toBe(true)
    expectRequests(configReads({ repo: '.prowlabels.yaml' }), [])
  })

  it('/kind with only values outside the allowlist fails naming them and the allowed values, without reading or writing labels', async () => {
    gh.route('GET', `${repo}/contents/.prowlabels.yaml`, { status: 200, body: labelFileContents })

    const result = await run('/kind not-allowed', '/kind')

    expect(result.status, result.stdout).toBe(1)
    expect(result.errors.some(e => e.includes('kind: no allowed value in "not-allowed"; allowed: failing-test, cleanup'))).toBe(true)
    expectRequests(configReads({ repo: '.prowlabels.yaml' }), [])
  })

  it('/kind without a value fails as missing args without reading or writing labels', async () => {
    gh.route('GET', `${repo}/contents/.prowlabels.yaml`, { status: 200, body: labelFileContents })

    const result = await run('/kind', '/kind')

    expect(result.status, result.stdout).toBe(1)
    expect(result.errors.some(e => e.includes('kind: command args missing from body'))).toBe(true)
    expectRequests(configReads({ repo: '.prowlabels.yaml' }), [])
  })

  it('/remove-kind with none of its labels on the issue reads the labels and removes nothing', async () => {
    gh.route('GET', `${repo}/contents/.prowlabels.yaml`, { status: 200, body: labelFileContents })
    gh.route('GET', `${repo}/issues/1`, { status: 200, body: { labels: [{ name: 'area/bug' }] } })

    const result = await run('/remove-kind cleanup', '/kind')

    expect(result.status, result.stdout).toBe(0)
    expect(result.errors).toEqual([])
    expect(gh.requestsMatching('DELETE', /./)).toEqual([])
    expectRequests(configReads({ repo: '.prowlabels.yaml' }), [`GET ${repo}/issues/1`])
  })

  it('/remove-kind fails naming the labels read when the issue cannot be read', async () => {
    gh.route('GET', `${repo}/contents/.prowlabels.yaml`, { status: 200, body: labelFileContents })
    gh.route('GET', `${repo}/issues/1`, { status: 500, body: { message: 'Internal Server Error' } })

    const result = await run('/remove-kind cleanup', '/kind')

    expect(result.status, result.stdout).toBe(1)
    expect(result.errors.some(e => e.includes('could not get labels from issue: Error: could not get issue'))).toBe(true)
    expect(gh.requestsMatching('DELETE', /./)).toEqual([])
    expectRequests(configReads({ repo: '.prowlabels.yaml' }), [`GET ${repo}/issues/1`])
  })

  it('/remove by a collaborator fails naming the labels read when the issue cannot be read', async () => {
    gh.route('GET', `${repo}/collaborators/Codertocat`, { status: 204 })
    gh.route('GET', `${repo}/issues/1`, { status: 500, body: { message: 'Internal Server Error' } })

    const result = await run('/remove foo', '/remove')

    expect(result.status, result.stdout).toBe(1)
    expect(result.errors.some(e => e.includes('could not get labels from issue: Error: could not get issue'))).toBe(true)
    expect(gh.requestsMatching('DELETE', /./)).toEqual([])
    expectCommandThenConfig([`GET ${repo}/collaborators/Codertocat`, `GET ${repo}/issues/1`])
  })

  it('/remove by a collaborator naming only labels the issue does not carry fails as missing args', async () => {
    gh.route('GET', `${repo}/collaborators/Codertocat`, { status: 204 })
    gh.route('GET', `${repo}/issues/1`, { status: 200, body: { labels: [{ name: 'bar' }] } })

    const result = await run('/remove foo', '/remove')

    expect(result.status, result.stdout).toBe(1)
    expect(result.errors.some(e => e.includes('remove: command args missing from body'))).toBe(true)
    expect(gh.requestsMatching('DELETE', /./)).toEqual([])
    expectCommandThenConfig([`GET ${repo}/collaborators/Codertocat`, `GET ${repo}/issues/1`])
  })
})
