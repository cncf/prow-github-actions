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
const labelsRead = `GET ${repo}/labels?per_page=100`

// the repository tier's probes, which the explicit source replaces the organization tier with
const repoReads = configReads().filter(read => read.startsWith(`GET ${repo}/`))

function yamlFile(text: string) {
  const file = structuredClone(labelFileContents)
  file.content = Buffer.from(text).toString('base64')
  return file
}

function repoLabels(...names: string[]) {
  return { status: 200, body: names.map(name => ({ name })) }
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

  it('reads an owner/repo:path source with github-token instead of the organization repos, then layers the repository on top', async () => {
    gh.route('GET', `${explicitRepo}/contents/prow.yaml`, { status: 200, body: yamlFile('labels:\n  kind: [cleanup]\n') })
    gh.route('GET', `${repo}/labels`, repoLabels('kind/cleanup'))
    gh.route('POST', `${repo}/issues/1/labels`, { status: 200, body: [] })

    const result = await kind('cncf/prow-config:prow.yaml')

    expect(result.status, result.stdout).toBe(0)
    expect(result.errors).toEqual([])
    expect(gh.requestsMatching('POST', /\/issues\/1\/labels$/).map(r => r.body)).toEqual([{ labels: ['kind/cleanup'] }])
    expect(calls().filter(c => c.includes('/.project/') || c.includes('/.github/contents/'))).toEqual([])
    expectRequests([explicitRead, ...repoReads, labelsRead], [`POST ${repo}/issues/1/labels`])
  })

  it('passes the @ref of the source as the contents ref', async () => {
    gh.route('GET', `${explicitRepo}/contents/prow.yaml`, { status: 200, body: yamlFile('labels:\n  kind: [cleanup]\n') })
    gh.route('GET', `${repo}/labels`, repoLabels('kind/cleanup'))
    gh.route('POST', `${repo}/issues/1/labels`, { status: 200, body: [] })

    const result = await kind('cncf/prow-config:prow.yaml@v1.2')

    expect(result.status, result.stdout).toBe(0)
    expect(gh.requestsMatching('GET', /\/prow-config\/contents\//).map(r => r.path)).toEqual([`${explicitRepo}/contents/prow.yaml?ref=v1.2`])
  })

  it('the repository tier still layers over the explicit source: its kind list replaces the explicit one', async () => {
    gh.route('GET', `${explicitRepo}/contents/prow.yaml`, { status: 200, body: yamlFile('labels:\n  kind: [cleanup]\n') })
    gh.route('GET', `${repo}/contents/.github%2Fprow.yaml`, { status: 200, body: yamlFile('labels:\n  kind: [bug]\n') })

    const result = await kind('cncf/prow-config:prow.yaml')

    // `cleanup` is only in the explicit source's list, which the repository's `kind: [bug]` replaced
    expect(result.status, result.stdout).toBe(1)
    expect(result.errors.some(e => e.includes('kind: command args missing from body')), result.stdout).toBe(true)
    expect(gh.requestsMatching('POST', /./)).toEqual([])
    expectRequests([explicitRead, ...configReads({ repo: '.github/prow.yaml' }).filter(r => r.startsWith(`GET ${repo}/`))], [])
  })

  it('an explicit source that does not exist fails the command as not found, with no repository label write', async () => {
    gh.route('GET', `${repo}/contents/.prowlabels.yaml`, { status: 200, body: yamlFile('labels:\n  kind: [cleanup]\n') })

    const result = await kind('cncf/prow-config:prow.yaml')

    expectConfigFailure(result, 'could not load prow config from cncf/prow-config:prow.yaml: not found')
    expectRequests([explicitRead, ...configReads({ repo: '.prowlabels.yaml' }).filter(r => r.startsWith(`GET ${repo}/`))], [])
  })

  it('an explicit source whose read fails surfaces the api error', async () => {
    gh.route('GET', `${explicitRepo}/contents/prow.yaml`, { status: 500, body: { message: 'boom' } })

    const result = await kind('cncf/prow-config:prow.yaml')

    expectConfigFailure(result, 'could not load prow config from cncf/prow-config:prow.yaml: HttpError: boom')
  })

  it('an explicit source that is a directory is refused as not a file', async () => {
    gh.route('GET', `${explicitRepo}/contents/configs`, { status: 200, body: [{ name: 'prow.yaml', type: 'file' }] })

    const result = await kind('cncf/prow-config:configs')

    expectConfigFailure(result, 'could not load prow config from cncf/prow-config:configs: TypeError: configs is not a file')
    expect(gh.requestsMatching('GET', /\/prow-config\//).map(r => r.path)).toEqual([`${explicitRepo}/contents/configs`])
  })

  it.each([
    ['an http:// url', 'http://config.example.com/prow.yaml', 'config: http:// sources are not allowed, use https://'],
    ['a bare file name', 'just-a-file.yaml', `config: expected owner/repo:path[@ref] or an https:// url, got 'just-a-file.yaml'`],
  ])('%s is refused before any read of the explicit source', async (_name, config, cause) => {
    const result = await kind(config)

    expectConfigFailure(result, cause)
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
