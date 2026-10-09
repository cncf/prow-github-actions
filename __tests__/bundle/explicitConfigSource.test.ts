import type { FakeGithub } from './fakeGithub'
import { Buffer } from 'node:buffer'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import labelFileContents from '../fixtures/labels/labelFileContentsResp.json'
import { start } from './fakeGithub'
import { comment, configReads, helpersFor, repo, token } from './helpers'
import { runBundle } from './runBundle'

vi.setConfig({ testTimeout: 30_000 })

const explicitRepo = '/repos/cncf/prow-config'
const explicitRead = `GET ${explicitRepo}/contents/prow.yaml`

function yamlFile(text: string) {
  const file = structuredClone(labelFileContents)
  file.content = Buffer.from(text).toString('base64')
  return file
}

// the `config` input — an explicit owner/repo:path[@ref] source replacing the organization lookup — and the
// loader's read failures, driven through dist/index.js by a /kind that needs the configuration
describe('dist/index.js prow configuration sources', () => {
  let gh: FakeGithub
  const { calls, expectRequests } = helpersFor(() => gh)

  beforeAll(async () => {
    gh = await start()
  })
  afterEach(() => gh.reset())
  afterAll(() => gh.close())

  function kind(config?: string) {
    return runBundle({
      eventName: 'issue_comment',
      payload: comment('/kind cleanup'),
      inputs: { ...token, 'prow-commands': '/kind', ...(config === undefined ? {} : { config }) },
      apiUrl: gh.url,
    })
  }

  function expectConfigFailure(result: Awaited<ReturnType<typeof runBundle>>, cause: string) {
    expect(result.status, result.stdout).toBe(1)
    expect(result.errors.some(e => e.includes(`could not get labels from yaml: Error: ${cause}`)), result.stdout).toBe(true)
    expect(gh.requestsMatching('POST', /./)).toEqual([])
  }

  it('an explicit source that does not exist fails the command as not found, with no repository label write', async () => {
    gh.route('GET', `${repo}/contents/.prowlabels.yaml`, { status: 200, body: yamlFile('labels:\n  kind: [cleanup]\n') })

    const result = await kind('cncf/prow-config:prow.yaml')

    expectConfigFailure(result, 'could not load prow config from cncf/prow-config:prow.yaml: not found')
    expectRequests([explicitRead, ...configReads({ repo: '.prowlabels.yaml' }).filter(r => r.startsWith(`GET ${repo}/`))], [])
  })

  it('an explicit source that is a directory is refused as not a file', async () => {
    gh.route('GET', `${explicitRepo}/contents/configs`, { status: 200, body: [{ name: 'prow.yaml', type: 'file' }] })

    const result = await kind('cncf/prow-config:configs')

    expectConfigFailure(result, 'could not load prow config from cncf/prow-config:configs: TypeError: configs is not a file')
    expect(gh.requestsMatching('GET', /\/prow-config\//).map(r => r.path)).toEqual([`${explicitRepo}/contents/configs`])
  })

  it('a bare file name is refused before any read of the explicit source', async () => {
    const result = await kind('just-a-file.yaml')

    expectConfigFailure(result, `config: expected owner/repo:path[@ref] or an https:// url, got 'just-a-file.yaml'`)
    // the repository tier is probed concurrently and still runs; only the explicit source is never read
    expect(calls().filter(c => !c.startsWith(`GET ${repo}/contents/`))).toEqual([])
  })

  it('a failed organization config read fails the command naming the organization source', async () => {
    gh.route('GET', '/repos/Codertocat/.project/contents/prow.yaml', { status: 500, body: { message: 'boom' } })

    const result = await kind()

    expectConfigFailure(result, 'could not load organization prow config from Codertocat/.project:prow.yaml: HttpError: boom')
    expect(calls()).not.toContain('GET /repos/Codertocat/.github/contents/prow.yaml')
  })

  it('a failed repository config read fails the command naming the repository file', async () => {
    gh.route('GET', `${repo}/contents/.github%2Fprow.yaml`, { status: 500, body: { message: 'boom' } })

    const result = await kind()

    expectConfigFailure(result, 'could not load prow config from Codertocat/Hello-World:.github/prow.yaml: HttpError: boom')
    expect(calls()).not.toContain(`GET ${repo}/contents/.github%2Fprowlabels.yaml`)
  })
})
