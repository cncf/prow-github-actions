import { generateKeyPairSync } from 'node:crypto'
import { http, passthrough } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { globalPlatformScope, installPlatformScope } from '../../src/platform'
import { main, runCronOnce } from '../../src/server/node'
import { signedRequest, withInstallation } from '../adapters/app/testApp'
import issueCommentEvent from '../fixtures/issues/issueCommentEvent.json'
import * as utils from '../testUtils'

const api = 'https://ghes.example/api/v3'
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'pkcs1', format: 'pem' } })
const webhookSecret = 'scope-secret'
const env = { GITHUB_APP_ID: '1', GITHUB_APP_PRIVATE_KEY: privateKey, GITHUB_WEBHOOK_SECRET: webhookSecret, GITHUB_API_URL: api }

const server = setupServer()
utils.failTestOnUnhandledRequests(server)

const installationToken = () => http.post(`${api}/app/installations/7/access_tokens`, utils.mockResponse(201, { token: 'ghs_scope', expires_at: new Date(Date.now() + 3_600_000).toISOString(), permissions: {}, repository_selection: 'all' }))
function noConfig() {
  return utils.configProbes.map((source) => {
    const [repo, path] = source.split(':')
    return http.get(`${api}/repos/${repo}/contents/${encodeURIComponent(path!)}`, utils.mockResponse(404, { message: 'Not Found' }))
  })
}

function errorLines(write: { mock: { calls: unknown[][] } }): string[] {
  return write.mock.calls.map(([chunk]) => String(chunk)).filter(line => line.includes('"level":"error"'))
}

// A fresh process has only the process-wide platform scope, which refuses async work (it would lose the platform at the
// first await), so the entry points themselves must install the async-local one before dispatching anything. The other
// server tests install it in their own setup, which hides an entry point that no longer does; here nothing does it for them.
describe('the server entry points install the async platform scope', () => {
  beforeAll(() => server.listen(utils.failOnUnhandledRequest))
  beforeEach(() => installPlatformScope(globalPlatformScope))
  afterEach(() => server.resetHandlers())
  afterAll(() => {
    server.close()
    installPlatformScope(globalPlatformScope)
  })

  it('runCronOnce runs an async scheduled job from the process-wide scope and reports it as succeeded', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const observeLabels = new utils.ObserveRequest()
    server.use(
      http.get(`${api}/app/installations`, utils.mockResponse(200, [{ id: 7, suspended_at: null }])),
      installationToken(),
      http.get(`${api}/installation/repositories`, utils.mockResponse(200, { total_count: 1, repositories: [{ name: 'Hello-World', full_name: 'Codertocat/Hello-World', owner: { login: 'Codertocat' }, archived: false }] })),
      ...noConfig(),
      http.get(`${api}/repos/Codertocat/Hello-World/labels`, utils.mockResponse(200, [], observeLabels)),
    )
    try {
      await expect(runCronOnce({ ...env, PROW_JOBS: 'label-sync', PROW_DRY_RUN: 'true' })).resolves.toBe(0)

      await observeLabels.called()
      expect(errorLines(write)).toEqual([])
    }
    finally {
      write.mockRestore()
    }
  })

  it('main() serves an async delivery from the process-wide scope through to its GitHub write', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const port = 21000 + Math.floor(Math.random() * 1000)
    const observeClose = new utils.ObserveRequest()
    server.use(
      http.all(`http://127.0.0.1:${port}/*`, () => passthrough()),
      installationToken(),
      ...noConfig(),
      http.get(`${api}/repos/Codertocat/Hello-World/collaborators/Codertocat`, utils.mockResponse(204)),
      http.patch(`${api}/repos/Codertocat/Hello-World/issues/1`, utils.mockResponse(200, null, observeClose)),
    )
    const listening = main({ ...env, PORT: String(port), PROW_COMMANDS: '/close' })
    try {
      await listening.ready
      const payload = withInstallation(issueCommentEvent)
      payload.comment.body = '/close'
      const signed = await signedRequest('issue_comment', payload, { secret: webhookSecret })
      const response = await fetch(`http://127.0.0.1:${port}/webhook`, { method: 'POST', headers: Object.fromEntries(signed.headers), body: await signed.text() })

      expect(response.status).toBe(202)
      await observeClose.called()
      expect(await observeClose.body()).toEqual({ state: 'closed' })
      expect(errorLines(write)).toEqual([])
    }
    finally {
      await listening.close()
      write.mockRestore()
    }
  })
})
