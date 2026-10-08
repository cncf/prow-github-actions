import type { AddressInfo } from 'node:net'
import type { FakeGithub } from './fakeGithub'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import https from 'node:https'
import os from 'node:os'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { start } from './fakeGithub'
import { comment, configReads, helpersFor, repo, token } from './helpers'
import { runBundle } from './runBundle'

vi.setConfig({ testTimeout: 30_000 })

const labelsRead = `GET ${repo}/labels?per_page=100`

// the repository tier's probes, which the explicit source replaces the organization tier with
const repoReads = configReads().filter(read => read.startsWith(`GET ${repo}/`))

interface ConfigServer {
  url: string
  certPath: string
  requests: string[]
  respond: (status: number, body: string) => void
  close: () => Promise<void>
}

// a TLS server standing in for wherever an `https://` config source is hosted; the child trusts its
// self-signed certificate through NODE_EXTRA_CA_CERTS, so no real certificate authority is involved
async function startConfigServer(): Promise<ConfigServer> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prow-config-tls-'))
  const keyPath = path.join(dir, 'key.pem')
  const certPath = path.join(dir, 'cert.pem')
  execFileSync('openssl', [
    'req',
    '-x509',
    '-newkey',
    'ec',
    '-pkeyopt',
    'ec_paramgen_curve:prime256v1',
    '-nodes',
    '-days',
    '1',
    '-subj',
    '/CN=localhost',
    '-addext',
    'subjectAltName=IP:127.0.0.1,DNS:localhost',
    '-keyout',
    keyPath,
    '-out',
    certPath,
  ], { stdio: 'ignore' })

  let response = { status: 200, body: '' }
  const requests: string[] = []
  const server = https.createServer({ key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) }, (req, res) => {
    requests.push(`${req.method} ${req.url}`)
    res.writeHead(response.status, { 'content-type': 'text/yaml' })
    res.end(response.body)
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo

  return {
    url: `https://127.0.0.1:${port}`,
    certPath,
    requests,
    respond: (status, body) => {
      response = { status, body }
    },
    close: async () => {
      await new Promise<void>(resolve => server.close(() => resolve()))
      fs.rmSync(dir, { recursive: true, force: true })
    },
  }
}

// the `config` input naming an `https://` url: `fetchUrl` in src/utils/config.ts, which reads the source with
// fetch instead of the api, driven through dist/index.js by a /kind that needs the configuration
describe('dist/index.js https:// prow configuration source', () => {
  let gh: FakeGithub
  let config: ConfigServer
  const { expectRequests } = helpersFor(() => gh)

  beforeAll(async () => {
    gh = await start()
    config = await startConfigServer()
  })
  afterEach(() => {
    gh.reset()
    config.requests.length = 0
  })
  afterAll(async () => {
    gh.close()
    await config.close()
  })

  function kind(source: string) {
    return runBundle({
      eventName: 'issue_comment',
      payload: comment('/kind cleanup'),
      inputs: { ...token, 'prow-commands': '/kind', 'config': source },
      apiUrl: gh.url,
      env: { NODE_EXTRA_CA_CERTS: config.certPath },
    })
  }

  function expectConfigFailure(result: Awaited<ReturnType<typeof runBundle>>, cause: string) {
    expect(result.status, result.stdout).toBe(1)
    expect(result.errors.some(e => e.includes(`could not get labels from yaml: Error: ${cause}`)), result.stdout).toBe(true)
    expect(gh.requestsMatching('POST', /./)).toEqual([])
  }

  it('fetches the source over https instead of the organization repos, then layers the repository on top', async () => {
    config.respond(200, 'labels:\n  kind: [cleanup]\n')
    gh.route('GET', `${repo}/labels`, { status: 200, body: [{ name: 'kind/cleanup' }] })
    gh.route('POST', `${repo}/issues/1/labels`, { status: 200, body: [] })

    const result = await kind(`${config.url}/prow.yaml`)

    expect(result.status, result.stdout).toBe(0)
    expect(result.errors).toEqual([])
    expect(config.requests).toEqual(['GET /prow.yaml'])
    expect(gh.requestsMatching('POST', /\/issues\/1\/labels$/).map(r => r.body)).toEqual([{ labels: ['kind/cleanup'] }])
    // the explicit source is not read through the api, and the organization tier is not probed at all
    expectRequests([...repoReads, labelsRead], [`POST ${repo}/issues/1/labels`])
  })

  it('a source answering a non-2xx status fails the command naming the status, with no label write', async () => {
    config.respond(500, 'boom')

    const result = await kind(`${config.url}/prow.yaml`)

    expectConfigFailure(result, `could not load prow config from ${config.url}/prow.yaml: HTTP 500`)
    expect(config.requests).toEqual(['GET /prow.yaml'])
  })

  it('a source that cannot be reached fails the command with the fetch error, with no label write', async () => {
    const unreachable = await startConfigServer()
    await unreachable.close()

    const result = await kind(`${unreachable.url}/prow.yaml`)

    expectConfigFailure(result, `could not load prow config from ${unreachable.url}/prow.yaml: TypeError: fetch failed`)
    expect(config.requests).toEqual([])
  })
})
