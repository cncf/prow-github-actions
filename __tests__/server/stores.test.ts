import { generateKeyPairSync } from 'node:crypto'
import { http } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { asyncLocalScope } from '../../src/adapters/app/scope'
import { receiveWebhook } from '../../src/adapters/app/webhook'
import { globalPlatformScope, installPlatformScope } from '../../src/platform'
import { buildApp, buildReceiver, main, maxWebhookBytes, memoryStores, redisStores, storesFromEnv } from '../../src/server/node'
import { signedRequest, withInstallation } from '../adapters/app/testApp'
import issueCommentEvent from '../fixtures/issues/issueCommentEvent.json'
import * as utils from '../testUtils'

vi.mock('redis', () => ({
  createClient: vi.fn(() => {
    const handlers = new Map<string, (e: unknown) => void>()
    return {
      on: (event: string, handler: (e: unknown) => void) => handlers.set(event, handler),
      connect: vi.fn(() => (globalThis as { __redisConnect?: Promise<void> }).__redisConnect ?? Promise.resolve()),
      close: vi.fn(async () => {}),
      isReady: true,
      set: vi.fn(async () => 'OK'),
      del: vi.fn(async () => 1),
      eval: vi.fn(async () => 1),
      emit: (event: string, e: unknown) => handlers.get(event)?.(e),
    }
  }),
}))

const api = 'https://api.github.com'
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'pkcs1', format: 'pem' } })
const secret = 'stores-secret'
const env = { GITHUB_APP_ID: '1', GITHUB_APP_PRIVATE_KEY: privateKey, GITHUB_WEBHOOK_SECRET: secret, PROW_COMMANDS: '/close' }

const server = setupServer()
const unhandled = utils.failTestOnUnhandledRequests(server)

describe('storesFromEnv', () => {
  it('is memory with no REDIS_URL and says nothing for one replica', () => {
    const lines: Record<string, unknown>[] = []
    const stores = storesFromEnv({}, line => lines.push(line))
    expect(stores.deliveries).toBeDefined()
    expect(lines).toEqual([])
  })

  it('warns when more than one replica runs without a REDIS_URL', () => {
    const lines: Record<string, unknown>[] = []
    storesFromEnv({ PROW_REPLICAS: '3' }, line => lines.push(line))
    expect(lines).toEqual([expect.objectContaining({ level: 'warning', message: expect.stringContaining('PROW_REPLICAS=3 without REDIS_URL') })])
  })

  it('connects to redis when REDIS_URL is set, logs the connection and redis errors, and closes', async () => {
    const lines: Record<string, unknown>[] = []
    const stores = storesFromEnv({ REDIS_URL: 'redis://x' }, line => lines.push(line))
    await stores.ready
    expect(lines).toContainEqual({ level: 'info', message: 'redis: connected' })

    const { createClient } = await import('redis')
    // no offline queue: while redis is away a command fails at once instead of hanging the delivery
    expect(createClient).toHaveBeenLastCalledWith({ url: 'redis://x', disableOfflineQueue: true })
    const client = vi.mocked(createClient).mock.results.at(-1)!.value as { emit: (e: string, v: unknown) => void, close: () => Promise<void> }
    client.emit('error', new Error('ECONNRESET'))
    client.emit('error', 'string error')
    expect(lines).toContainEqual({ level: 'error', message: 'redis: ECONNRESET' })
    expect(lines).toContainEqual({ level: 'error', message: 'redis: string error' })

    await stores.close()
    expect(client.close).toHaveBeenCalled()
  })
})

describe('the server with stores', () => {
  beforeAll(() => {
    server.listen(utils.failOnUnhandledRequest)
    installPlatformScope(asyncLocalScope())
  })
  afterEach(() => server.resetHandlers())
  afterAll(() => {
    server.close()
    installPlatformScope(globalPlatformScope)
  })

  it('/readyz is 503 until the stores are ready, then 200; /healthz is always 200', async () => {
    let connect!: () => void
    ;(globalThis as { __redisConnect?: Promise<void> }).__redisConnect = new Promise<void>((resolve) => {
      connect = resolve
    })
    try {
      const stores = redisStores('redis://x', () => {})
      const app = buildApp(buildReceiver(env, stores, () => {}), stores)

      const healthy = await app.fetch(new Request('https://prow.test/healthz'))
      expect([healthy.status, await healthy.text()]).toEqual([200, 'ok'])
      const notReady = await app.fetch(new Request('https://prow.test/readyz'))
      expect([notReady.status, await notReady.text()]).toEqual([503, 'stores not ready'])
      connect()
      await stores.ready
      const ready = await app.fetch(new Request('https://prow.test/readyz'))
      expect([ready.status, await ready.text()]).toEqual([200, 'ok'])

      // the connection drops after startup: not ready until it is back
      const { createClient } = await import('redis')
      const client = vi.mocked(createClient).mock.results.at(-1)!.value as { isReady: boolean }
      client.isReady = false
      const dropped = await app.fetch(new Request('https://prow.test/readyz'))
      expect([dropped.status, await dropped.text()]).toEqual([503, 'stores not ready'])
      client.isReady = true
      expect((await app.fetch(new Request('https://prow.test/readyz'))).status).toBe(200)
    }
    finally {
      delete (globalThis as { __redisConnect?: Promise<void> }).__redisConnect
    }
  })

  it('/readyz stays 503 when the stores never come up', async () => {
    ;(globalThis as { __redisConnect?: Promise<void> }).__redisConnect = Promise.reject(new Error('refused'))
    try {
      const stores = redisStores('redis://x', () => {})
      await stores.ready.catch(() => {})
      const app = buildApp(buildReceiver(env, stores, () => {}), stores)
      await new Promise(resolve => setTimeout(resolve, 0))
      expect((await app.fetch(new Request('https://prow.test/readyz'))).status).toBe(503)
    }
    finally {
      delete (globalThis as { __redisConnect?: Promise<void> }).__redisConnect
    }
  })

  it('runs two deliveries for one pull request one after the other, and tracks them in flight until done', async () => {
    const stores = memoryStores()
    const receiver = buildReceiver(env, stores, () => {})
    const app = buildApp(receiver, stores)
    const order: string[] = []
    let releaseFirst!: () => void
    const firstHeld = new Promise<void>((resolve) => {
      releaseFirst = resolve
    })
    let patches = 0
    server.use(
      http.post(`${api}/app/installations/7/access_tokens`, utils.mockResponse(201, { token: 't', expires_at: new Date(Date.now() + 3_600_000).toISOString(), permissions: {}, repository_selection: 'all' })),
      http.patch(`${api}/repos/Codertocat/Hello-World/issues/1`, async () => {
        patches++
        order.push(`patch:${patches}:start`)
        if (patches === 1) {
          await firstHeld
        }
        order.push(`patch:${patches}:end`)
        return new Response('{}', { headers: { 'Content-Type': 'application/json' } })
      }),
    )
    const payload = withInstallation(issueCommentEvent)
    payload.comment.body = '/close'

    const r1 = await app.fetch(await signedRequest('issue_comment', payload, { secret, id: 'one' }))
    const r2 = await app.fetch(await signedRequest('issue_comment', payload, { secret, id: 'two' }))
    expect([r1.status, r2.status]).toEqual([202, 202])
    expect(receiver.inFlight.size).toBe(2)
    await vi.waitFor(() => expect(order).toEqual(['patch:1:start']))
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(order).toEqual(['patch:1:start'])

    releaseFirst()
    await Promise.all([...receiver.inFlight])
    await new Promise(resolve => setTimeout(resolve, 0))

    expect(order).toEqual(['patch:1:start', 'patch:1:end', 'patch:2:start', 'patch:2:end'])
    expect(receiver.inFlight.size).toBe(0)
  })

  it('runs an event about no issue or pull request without taking a lock', async () => {
    const seen: string[] = []
    const stores = { ...memoryStores(), locks: { withLock: async <T>(key: string, fn: () => Promise<T>) => {
      seen.push(key)
      return fn()
    } } }
    const receiver = buildReceiver(env, stores, () => {})
    server.use(http.post(`${api}/app/installations/7/access_tokens`, utils.mockResponse(201, { token: 't', expires_at: new Date(Date.now() + 3_600_000).toISOString(), permissions: {}, repository_selection: 'all' })))
    // the push handler goes on to probe prow.yaml; the key is what this case is about
    unhandled.allow()

    const { handled } = await receiveWebhook(receiver, await signedRequest('push', { ref: 'refs/heads/main', repository: issueCommentEvent.repository, installation: { id: 7 } }, { secret, id: 'push-1' }))
    await handled

    expect(seen).toEqual([])
  })

  it('answers 413 to a webhook body above 25 MB without reading it or consulting the store', async () => {
    const receiver = { ...buildReceiver(env, memoryStores(), () => {}), deliveries: { seen: async (): Promise<boolean> => {
      throw new Error('store must not be consulted')
    } } }
    const app = buildApp(receiver)
    const signed = await signedRequest('issue_comment', withInstallation(issueCommentEvent), { secret })
    const headers = new Headers(signed.headers)
    headers.set('content-length', String(maxWebhookBytes + 1))

    const response = await app.fetch(new Request('https://prow.test/webhook', { method: 'POST', headers, body: await signed.text() }))

    expect([response.status, await response.text()]).toEqual([413, 'payload too large'])
    expect(maxWebhookBytes).toBe(25 * 1024 * 1024)
  })

  it('answers 413 to a streamed body that grows past the cap', async () => {
    const app = buildApp(buildReceiver(env, memoryStores(), () => {}))
    const chunk = new Uint8Array(1024 * 1024)
    let sent = 0
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent++ > 26) {
          controller.close()
          return
        }
        controller.enqueue(chunk)
      },
    })

    const response = await app.fetch(new Request('https://prow.test/webhook', { method: 'POST', headers: { 'x-github-delivery': 'big', 'x-github-event': 'push' }, body, duplex: 'half' } as RequestInit))

    expect(response.status).toBe(413)
  })

  it('main() drains in-flight deliveries on SIGTERM, closes the stores and exits 0', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const signals = new (await import('node:events')).EventEmitter() as unknown as NodeJS.Process
    const exit = vi.fn()
    ;(signals as unknown as { exit: typeof exit }).exit = exit
    const port = 20000 + Math.floor(Math.random() * 1000)
    const { passthrough } = await import('msw')
    server.use(http.all(`http://127.0.0.1:${port}/*`, () => passthrough()))
    let releaseHandler!: () => void
    const held = new Promise<void>((resolve) => {
      releaseHandler = resolve
    })
    server.use(
      http.post(`${api}/app/installations/7/access_tokens`, async () => {
        await held
        return Response.json({ token: 't', expires_at: new Date(Date.now() + 3_600_000).toISOString(), permissions: {}, repository_selection: 'all' }, { status: 201 })
      }),
      http.get(`${api}/repos/Codertocat/Hello-World/collaborators/Codertocat`, utils.mockResponse(204)),
      http.patch(`${api}/repos/Codertocat/Hello-World/issues/1`, utils.mockResponse(200, {})),
    )
    const listening = main({ ...env, PORT: String(port), REDIS_URL: 'redis://x', PROW_SHUTDOWN_GRACE_MS: '5000', PROW_SHUTDOWN_DRAIN_MS: '0' }, signals)
    try {
      await listening.ready
      const payload = withInstallation(issueCommentEvent)
      payload.comment.body = '/close'
      const signed = await signedRequest('issue_comment', payload, { secret })
      const response = await fetch(`http://127.0.0.1:${port}/webhook`, { method: 'POST', headers: Object.fromEntries(signed.headers), body: await signed.text() })
      expect(response.status).toBe(202)

      signals.emit('SIGTERM')
      await new Promise(resolve => setTimeout(resolve, 20))
      expect(exit).not.toHaveBeenCalled()
      const logged = () => write.mock.calls.map(call => JSON.parse(String(call[0])) as { level: string, message: string })
      expect(logged().filter(line => /in-flight/.test(line.message))).toEqual([{ level: 'info', message: 'shutting down: waiting up to 5000ms for 1 in-flight deliveries', time: expect.any(String) }])

      releaseHandler()
      await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0))
      expect(logged().at(-1)).toEqual({ level: 'info', message: 'shut down', time: expect.any(String) })
    }
    finally {
      await listening.close(0)
      write.mockRestore()
    }
  })

  it('main() with nothing in flight stops listening and closes without waiting on a grace period', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const signals = new (await import('node:events')).EventEmitter() as unknown as NodeJS.Process
    const exit = vi.fn()
    ;(signals as unknown as { exit: typeof exit }).exit = exit
    const port = 23000 + Math.floor(Math.random() * 1000)
    const { passthrough } = await import('msw')
    server.use(http.all(`http://127.0.0.1:${port}/*`, () => passthrough()))
    const listening = main({ ...env, PORT: String(port), REDIS_URL: 'redis://x', PROW_SHUTDOWN_GRACE_MS: '60000', PROW_SHUTDOWN_DRAIN_MS: '0' }, signals)
    try {
      await listening.ready
      expect((await fetch(`http://127.0.0.1:${port}/healthz`)).status).toBe(200)
      const { createClient } = await import('redis')
      const client = vi.mocked(createClient).mock.results.at(-1)!.value as { close: ReturnType<typeof vi.fn> }

      signals.emit('SIGTERM')
      await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0))

      expect(client.close).toHaveBeenCalledOnce()
      const logged = write.mock.calls.map(call => JSON.parse(String(call[0])) as { message: string })
      expect(logged.map(line => line.message)).toEqual(['redis: connected', `listening on :${port}`, 'shutting down: not ready, serving for 0ms more', 'shut down'])
      await expect(fetch(`http://127.0.0.1:${port}/healthz`)).rejects.toThrow()
    }
    finally {
      await listening.close(0)
      write.mockRestore()
    }
  })

  it('main() gives up waiting after the grace period', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const signals = new (await import('node:events')).EventEmitter() as unknown as NodeJS.Process
    const exit = vi.fn()
    ;(signals as unknown as { exit: typeof exit }).exit = exit
    const port = 21000 + Math.floor(Math.random() * 1000)
    const { passthrough } = await import('msw')
    server.use(http.all(`http://127.0.0.1:${port}/*`, () => passthrough()))
    // @octokit/auth-app shares one pending-request map per installation across every
    // createAppAuth in the process, so a token request this test never answered would
    // hang the next test of this file that mints a token for installation 7
    let abandonToken!: () => void
    const tokenHeld = new Promise<void>((resolve) => {
      abandonToken = resolve
    })
    server.use(http.post(`${api}/app/installations/7/access_tokens`, async () => {
      await tokenHeld
      return new Response('abandoned by the test', { status: 500 })
    }))
    const listening = main({ ...env, PORT: String(port), PROW_SHUTDOWN_GRACE_MS: '30', PROW_SHUTDOWN_DRAIN_MS: '0' }, signals)
    try {
      await listening.ready
      const payload = withInstallation(issueCommentEvent)
      payload.comment.body = '/close'
      const signed = await signedRequest('issue_comment', payload, { secret })
      await fetch(`http://127.0.0.1:${port}/webhook`, { method: 'POST', headers: Object.fromEntries(signed.headers), body: await signed.text() })

      signals.emit('SIGINT')
      await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0))
    }
    finally {
      abandonToken()
      await vi.waitFor(() => expect(write.mock.calls.map(call => JSON.parse(String(call[0])) as { level: string })).toContainEqual(expect.objectContaining({ level: 'error' })))
      await listening.close(0)
      write.mockRestore()
    }
  })

  it('main() on SIGTERM answers /readyz 503 and keeps serving for the drain period (5 s by default), then closes', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout'] })
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const signals = new (await import('node:events')).EventEmitter() as unknown as NodeJS.Process
    const exit = vi.fn()
    ;(signals as unknown as { exit: typeof exit }).exit = exit
    const port = 24000 + Math.floor(Math.random() * 1000)
    const { passthrough } = await import('msw')
    server.use(http.all(`http://127.0.0.1:${port}/*`, () => passthrough()))
    const listening = main({ ...env, PORT: String(port) }, signals)
    try {
      await listening.ready
      expect((await fetch(`http://127.0.0.1:${port}/readyz`)).status).toBe(200)

      signals.emit('SIGTERM')
      const readyz = await fetch(`http://127.0.0.1:${port}/readyz`)
      expect([readyz.status, await readyz.text()]).toEqual([503, 'shutting down'])
      await vi.advanceTimersByTimeAsync(4_999)
      expect((await fetch(`http://127.0.0.1:${port}/healthz`)).status).toBe(200)
      expect(exit).not.toHaveBeenCalled()

      await vi.advanceTimersByTimeAsync(1)
      await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0))
      const logged = write.mock.calls.map(call => JSON.parse(String(call[0])) as { message: string })
      expect(logged.map(line => line.message)).toEqual([`listening on :${port}`, 'shutting down: not ready, serving for 5000ms more', 'shut down'])
    }
    finally {
      vi.useRealTimers()
      await listening.close(0)
      write.mockRestore()
    }
  })

  it('main() exits 1 when closing the stores fails', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const signals = new (await import('node:events')).EventEmitter() as unknown as NodeJS.Process
    const exit = vi.fn()
    ;(signals as unknown as { exit: typeof exit }).exit = exit
    const port = 22000 + Math.floor(Math.random() * 1000)
    const listening = main({ ...env, PORT: String(port), REDIS_URL: 'redis://x', PROW_SHUTDOWN_DRAIN_MS: '0' }, signals)
    try {
      await listening.ready
      const { createClient } = await import('redis')
      const client = vi.mocked(createClient).mock.results.at(-1)!.value as { close: ReturnType<typeof vi.fn> }
      client.close.mockRejectedValueOnce(new Error('cannot close'))
      signals.emit('SIGTERM')
      await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(1))
    }
    finally {
      write.mockRestore()
    }
  })
})
