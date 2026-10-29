import { generateKeyPairSync } from 'node:crypto'
import { http, passthrough } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { asyncLocalScope } from '../../../src/adapters/app/scope'
import { globalPlatformScope, installPlatformScope } from '../../../src/platform'
import { buildApp, buildReceiver, buildScheduler, main, runCronOnce } from '../../../src/server/node'
import issueCommentEvent from '../../fixtures/issues/issueCommentEvent.json'
import * as utils from '../../testUtils'
import { signedRequest, withInstallation } from './testApp'

const api = 'https://ghes.example/api/v3'
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'pkcs1', format: 'pem' } })
const webhookSecret = 'e2e-secret'

const server = setupServer()
utils.failTestOnUnhandledRequests(server)

describe('the node server end to end', () => {
  beforeAll(() => {
    server.listen(utils.failOnUnhandledRequest)
    installPlatformScope(asyncLocalScope())
  })
  afterEach(() => server.resetHandlers())
  afterAll(() => {
    server.close()
    installPlatformScope(globalPlatformScope)
  })

  it('mints an installation token with the app jwt, then closes the issue /close names, against a GHES api url', async () => {
    const lines: Record<string, unknown>[] = []
    const backgrounded: Promise<void>[] = []
    const receiver = buildReceiver({
      GITHUB_APP_ID: '4242',
      GITHUB_APP_PRIVATE_KEY: privateKey,
      GITHUB_WEBHOOK_SECRET: webhookSecret,
      GITHUB_API_URL: api,
      PROW_COMMANDS: '/close',
    })
    receiver.sink = line => lines.push(line)
    receiver.background = work => backgrounded.push(work)
    const app = buildApp(receiver)

    const observeToken = new utils.ObserveRequest()
    const observeClose = new utils.ObserveRequest()
    server.use(
      http.post(`${api}/app/installations/7/access_tokens`, utils.mockResponse(201, { token: 'ghs_minted', expires_at: new Date(Date.now() + 3_600_000).toISOString(), permissions: {}, repository_selection: 'all' }, observeToken)),
      http.get(`${api}/repos/Codertocat/Hello-World/collaborators/Codertocat`, utils.mockResponse(204)),
      http.patch(`${api}/repos/Codertocat/Hello-World/issues/1`, utils.mockResponse(200, null, observeClose)),
    )

    const payload = withInstallation(issueCommentEvent)
    payload.comment.body = '/close'
    const response = await app.fetch(await signedRequest('issue_comment', payload, { secret: webhookSecret }))

    expect(response.status).toBe(202)
    expect(backgrounded).toHaveLength(1)
    await backgrounded[0]

    await observeToken.called()
    expect(observeToken.ref?.headers.get('authorization')).toMatch(/^bearer ey/i)
    await observeClose.called()
    expect(observeClose.ref?.headers.get('authorization')).toBe('token ghs_minted')
    expect(await observeClose.body()).toEqual({ state: 'closed' })
    expect(lines.filter(line => line.level === 'error')).toEqual([])
  })

  it('main() listens on PORT, logs json lines to stdout and answers a signed ping', async () => {
    const written: string[] = []
    const write = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      written.push(String(chunk))
      return true
    })
    const port = 18000 + Math.floor(Math.random() * 1000)
    server.use(http.all(`http://127.0.0.1:${port}/*`, () => passthrough()))
    const listening = main({ GITHUB_APP_ID: '1', GITHUB_APP_PRIVATE_KEY: privateKey, GITHUB_WEBHOOK_SECRET: webhookSecret, PORT: String(port) })
    try {
      await listening.ready
      const response = await fetch(`http://127.0.0.1:${port}/webhook`, { method: 'POST', headers: Object.fromEntries((await signedRequest('ping', { zen: 'x' }, { secret: webhookSecret })).headers), body: JSON.stringify({ zen: 'x' }) })

      expect(response.status).toBe(200)
      expect(written.map(line => JSON.parse(line))).toContainEqual(expect.objectContaining({ level: 'info', message: `listening on :${port}` }))
    }
    finally {
      listening.close()
      write.mockRestore()
    }
  })

  it('runCronOnce runs the scheduled jobs for every installation and exits 0 when none failed, 1 otherwise', async () => {
    const env = { GITHUB_APP_ID: '1', GITHUB_APP_PRIVATE_KEY: privateKey, GITHUB_WEBHOOK_SECRET: 's', GITHUB_API_URL: api, PROW_JOBS: 'label-sync', PROW_DRY_RUN: 'true' }
    const noConfig = utils.configProbes.map((source) => {
      const [r, path] = source.split(':')
      return http.get(`${api}/repos/${r}/contents/${encodeURIComponent(path!)}`, utils.mockResponse(404, { message: 'Not Found' }))
    })
    const installations = (repos: { name: string, owner: string }[]) => [
      http.get(`${api}/app/installations`, utils.mockResponse(200, [{ id: 7, suspended_at: null }])),
      http.post(`${api}/app/installations/7/access_tokens`, utils.mockResponse(201, { token: 'ghs_cron', expires_at: new Date(Date.now() + 3_600_000).toISOString(), permissions: {}, repository_selection: 'all' })),
      http.get(`${api}/installation/repositories`, utils.mockResponse(200, { total_count: repos.length, repositories: repos.map(r => ({ name: r.name, full_name: `${r.owner}/${r.name}`, owner: { login: r.owner }, archived: false })) })),
    ]
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    try {
      server.use(
        ...installations([{ owner: 'Codertocat', name: 'Hello-World' }]),
        ...noConfig,
        http.get(`${api}/repos/Codertocat/Hello-World/labels`, utils.mockResponse(200, [])),
      )
      await expect(runCronOnce(env)).resolves.toBe(0)

      server.resetHandlers()
      server.use(
        ...installations([{ owner: 'Codertocat', name: 'Hello-World' }]),
        ...noConfig,
        http.get(`${api}/repos/Codertocat/Hello-World/labels`, utils.mockResponse(500, { message: 'down' })),
      )
      await expect(runCronOnce(env)).resolves.toBe(1)
    }
    finally {
      write.mockRestore()
    }
  })

  it('buildScheduler dispatches to handleCronJobs with the receiver\'s settings', () => {
    const receiver = buildReceiver({ GITHUB_APP_ID: '1', GITHUB_APP_PRIVATE_KEY: privateKey, GITHUB_WEBHOOK_SECRET: 's' })

    const scheduler = buildScheduler(receiver)

    expect(scheduler.settings).toBe(receiver.settings)
    expect(scheduler.tokens).toBe(receiver.tokens)
  })

  it('main() with PROW_CRON_INTERVAL runs the scheduled jobs on the interval and stops on close', async () => {
    vi.useFakeTimers()
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const port = 19000 + Math.floor(Math.random() * 1000)
    server.use(http.all(`http://127.0.0.1:${port}/*`, () => passthrough()))
    const listening = main({ GITHUB_APP_ID: '1', GITHUB_APP_PRIVATE_KEY: privateKey, GITHUB_WEBHOOK_SECRET: 's', GITHUB_API_URL: api, PORT: String(port), PROW_CRON_INTERVAL: '1' })
    try {
      let polls = 0
      let settled!: () => void
      let done = new Promise<void>((resolve) => {
        settled = resolve
      })
      server.use(http.get(`${api}/app/installations`, () => {
        polls++
        settled()
        return new Response('[]', { headers: { 'Content-Type': 'application/json' } })
      }))
      await vi.advanceTimersByTimeAsync(60_000)
      await done
      done = new Promise<void>((resolve) => {
        settled = resolve
      })
      await vi.advanceTimersByTimeAsync(60_000)
      await done
      expect(polls).toBe(2)
      listening.close()
      await vi.advanceTimersByTimeAsync(60_000)
      expect(polls).toBe(2)
    }
    finally {
      listening.close()
      vi.useRealTimers()
      write.mockRestore()
    }
  })

  it('serves /healthz', async () => {
    const app = buildApp(buildReceiver({ GITHUB_APP_ID: '1', GITHUB_APP_PRIVATE_KEY: privateKey, GITHUB_WEBHOOK_SECRET: 's' }))

    const response = await app.fetch(new Request('https://prow.example/healthz'))

    expect(response.status).toBe(200)
    expect(await response.text()).toBe('ok')
  })
})
