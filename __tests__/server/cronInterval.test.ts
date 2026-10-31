import { generateKeyPairSync } from 'node:crypto'
import { http, passthrough } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { globalPlatformScope, installPlatformScope } from '../../src/platform'
import { main } from '../../src/server/node'
import * as utils from '../testUtils'

const api = 'https://ghes.example/api/v3'
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'pkcs1', format: 'pem' } })
const env = { GITHUB_APP_ID: '1', GITHUB_APP_PRIVATE_KEY: privateKey, GITHUB_WEBHOOK_SECRET: 's', GITHUB_API_URL: api }

const server = setupServer()
utils.failTestOnUnhandledRequests(server)

function stdoutLines(write: { mock: { calls: unknown[][] } }): Record<string, unknown>[] {
  return write.mock.calls.map(([chunk]) => JSON.parse(String(chunk)) as Record<string, unknown>)
}

describe('main() and PROW_CRON_INTERVAL', () => {
  beforeAll(() => server.listen(utils.failOnUnhandledRequest))
  afterEach(() => server.resetHandlers())
  afterAll(() => {
    server.close()
    installPlatformScope(globalPlatformScope)
  })

  it('logs a tick whose scheduled run rejects and keeps serving and ticking', async () => {
    vi.useFakeTimers()
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const port = 20000 + Math.floor(Math.random() * 1000)
    server.use(http.all(`http://127.0.0.1:${port}/*`, () => passthrough()))
    const listening = main({ ...env, PORT: String(port), PROW_CRON_INTERVAL: '1' })
    try {
      let polls = 0
      let settled!: () => void
      let polled = new Promise<void>((resolve) => {
        settled = resolve
      })
      server.use(http.get(`${api}/app/installations`, () => {
        polls++
        settled()
        return new Response('{"message":"boom"}', { status: 500, headers: { 'Content-Type': 'application/json' } })
      }))

      await vi.advanceTimersByTimeAsync(60_000)
      await polled
      await vi.waitFor(() => expect(stdoutLines(write)).toContainEqual(expect.objectContaining({ level: 'error', event: 'schedule' })))

      const logged = stdoutLines(write).find(line => line.level === 'error')!
      expect(logged.message).toContain('boom')
      expect(logged).not.toHaveProperty('repo')

      await listening.ready
      const health = await fetch(`http://127.0.0.1:${port}/healthz`)
      expect(health.status).toBe(200)

      polled = new Promise<void>((resolve) => {
        settled = resolve
      })
      await vi.advanceTimersByTimeAsync(60_000)
      await polled
      await vi.waitFor(() => expect(stdoutLines(write).filter(line => line.level === 'error')).toHaveLength(2))
      expect(polls).toBe(2)

      // closing clears the interval: another period passes with no further run
      await listening.close()
      await vi.advanceTimersByTimeAsync(60_000)
      expect(polls).toBe(2)
    }
    finally {
      await listening.close()
      vi.useRealTimers()
      write.mockRestore()
    }
  })

  it('does not schedule anything when PROW_CRON_INTERVAL is unset', async () => {
    vi.useFakeTimers()
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const port = 20000 + Math.floor(Math.random() * 1000)
    server.use(http.all(`http://127.0.0.1:${port}/*`, () => passthrough()))
    let polls = 0
    server.use(http.get(`${api}/app/installations`, () => {
      polls++
      return new Response('[]', { headers: { 'Content-Type': 'application/json' } })
    }))
    const listening = main({ ...env, PORT: String(port) })
    try {
      await listening.ready
      await vi.advanceTimersByTimeAsync(24 * 60 * 60_000)

      expect(polls).toBe(0)
      expect(stdoutLines(write)).toEqual([expect.objectContaining({ level: 'info', message: `listening on :${port}` })])
    }
    finally {
      listening.close()
      vi.useRealTimers()
      write.mockRestore()
    }
  })
})
