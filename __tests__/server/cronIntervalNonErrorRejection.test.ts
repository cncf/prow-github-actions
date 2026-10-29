import { generateKeyPairSync } from 'node:crypto'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { runScheduledJobs } from '../../src/adapters/app/cron'
import { main } from '../../src/server/node'

// runScheduledJobs only ever rejects with what the installation lister throws, and
// octokit throws Errors; the module is mocked to reach the String(error) arm.
vi.mock('../../src/adapters/app/cron', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/adapters/app/cron')>()
  return { ...actual, runScheduledJobs: vi.fn() }
})

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'pkcs1', format: 'pem' } })

describe('main() when a scheduled tick rejects with a non-Error', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('logs the rejected value as its string form', async () => {
    vi.useFakeTimers()
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    // eslint-disable-next-line prefer-promise-reject-errors
    vi.mocked(runScheduledJobs).mockImplementation(() => Promise.reject({ code: 'ETIMEDOUT' }))
    const port = 21000 + Math.floor(Math.random() * 1000)
    const listening = main({ GITHUB_APP_ID: '1', GITHUB_APP_PRIVATE_KEY: privateKey, GITHUB_WEBHOOK_SECRET: 's', PORT: String(port), PROW_CRON_INTERVAL: '2' })
    try {
      await vi.advanceTimersByTimeAsync(120_000)

      const lines = write.mock.calls.map(([chunk]) => JSON.parse(String(chunk)) as Record<string, unknown>)
      expect(runScheduledJobs).toHaveBeenCalledTimes(1)
      expect(lines).toContainEqual(expect.objectContaining({ level: 'error', event: 'schedule', message: '[object Object]' }))
    }
    finally {
      listening.close()
    }
  })
})
