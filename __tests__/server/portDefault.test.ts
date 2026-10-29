import { generateKeyPairSync } from 'node:crypto'
import { serve } from '@hono/node-server'
import { describe, expect, it, vi } from 'vitest'

import { main } from '../../src/server/node'

// serve is mocked so the default port is observed without binding :8080 on the test host
vi.mock('@hono/node-server', () => ({
  serve: vi.fn((_options: unknown, listening: () => void) => {
    listening()
    return { close: vi.fn() }
  }),
}))

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'pkcs1', format: 'pem' } })

describe('main() without PORT', () => {
  it('listens on 8080', async () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true)
    const listening = main({ GITHUB_APP_ID: '1', GITHUB_APP_PRIVATE_KEY: privateKey, GITHUB_WEBHOOK_SECRET: 's' })
    try {
      await listening.ready

      expect(serve).toHaveBeenCalledWith(expect.objectContaining({ port: 8080 }), expect.any(Function))
      expect(write.mock.calls.map(([chunk]) => JSON.parse(String(chunk)))).toEqual([expect.objectContaining({ message: 'listening on :8080' })])
    }
    finally {
      listening.close()
      write.mockRestore()
    }
  })
})
