import type { FakeGithub } from './fakeGithub'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { start } from './fakeGithub'
import { comment, helpersFor, repo, token } from './helpers'
import { runBundle } from './runBundle'

vi.setConfig({ testTimeout: 30_000 })

const explicitRepo = '/repos/cncf/prow-config'

// the `config` input — an explicit owner/repo:path[@ref] source replacing the organization lookup — and the
// loader's read failures, driven through dist/index.js by a /kind that needs the configuration
describe('dist/index.js prow configuration sources', () => {
  let gh: FakeGithub
  const { calls } = helpersFor(() => gh)

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

  it('an explicit source that is a directory is refused as not a file', async () => {
    gh.route('GET', `${explicitRepo}/contents/configs`, { status: 200, body: [{ name: 'prow.yaml', type: 'file' }] })

    const result = await kind('cncf/prow-config:configs')

    expectConfigFailure(result, 'could not load prow config from cncf/prow-config:configs: TypeError: configs is not a file')
    expect(gh.requestsMatching('GET', /\/prow-config\//).map(r => r.path)).toEqual([`${explicitRepo}/contents/configs`])
  })

  it('an explicit source whose file does not exist at the ref fails as not found, not as a read error', async () => {
    const result = await kind('cncf/prow-config:configs/prow.yaml@v2')

    expectConfigFailure(result, 'could not load prow config from cncf/prow-config:configs/prow.yaml@v2: not found')
    // the 404 is swallowed by the reader and surfaces as the loader's own message; the ref is passed through
    expect(gh.requestsMatching('GET', /\/prow-config\//).map(r => r.path)).toEqual([`${explicitRepo}/contents/configs%2Fprow.yaml?ref=v2`])
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
