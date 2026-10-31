import type { RedisLike } from '../../../src/adapters/app/redis'
import process from 'node:process'
import { createClient } from 'redis'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { redisDeliveryStore, redisLocks } from '../../../src/adapters/app/redis'
import * as sleepModule from '../../../src/utils/sleep'

/** an in-memory SET NX / EVAL that is good enough for the two scripts the stores use */
function fakeRedis(): RedisLike & { store: Map<string, string>, calls: string[] } {
  const store = new Map<string, string>()
  const calls: string[] = []
  return {
    store,
    calls,
    async set(key, value, options) {
      calls.push(`set ${key} ${JSON.stringify(options)}`)
      if (options.NX && store.has(key)) {
        return null
      }
      store.set(key, value)
      return 'OK'
    },
    async eval(_script, { keys, arguments: args }) {
      calls.push(`eval ${keys[0]}`)
      if (store.get(keys[0]!) === args[0]) {
        store.delete(keys[0]!)
        return 1
      }
      return 0
    },
  }
}

describe('redisDeliveryStore', () => {
  it('reports an id the first time as new and every later time as seen, with the ttl', async () => {
    const client = fakeRedis()
    const store = redisDeliveryStore(client, 123)

    expect(await store.seen('a')).toBe(false)
    expect(await store.seen('a')).toBe(true)
    expect(await store.seen('b')).toBe(false)
    expect(client.calls[0]).toBe('set prow:delivery:a {"NX":true,"EX":123}')
  })
})

describe('redisLocks', () => {
  it('holds the key while fn runs and releases it by token afterwards', async () => {
    const client = fakeRedis()
    const locks = redisLocks(client, { ttlMs: 500 })

    await locks.withLock('o/r#1', async () => {
      expect(client.store.get('prow:lock:o/r#1')).toMatch(/^\d+-/)
    })

    expect(client.store.has('prow:lock:o/r#1')).toBe(false)
    expect(client.calls).toEqual(['set prow:lock:o/r#1 {"NX":true,"PX":500}', 'eval prow:lock:o/r#1'])
  })

  it('takes the lock for 60 s unless told otherwise', async () => {
    const client = fakeRedis()

    await redisLocks(client).withLock('k', async () => {})

    expect(client.calls[0]).toBe('set prow:lock:k {"NX":true,"PX":60000}')
  })

  it('waits for a held lock, then takes it', async () => {
    const client = fakeRedis()
    const sleep = vi.spyOn(sleepModule, 'sleep').mockImplementation(async () => {
      client.store.delete('prow:lock:k')
    })
    client.store.set('prow:lock:k', 'someone-else')

    await expect(redisLocks(client, { retryMs: 5 }).withLock('k', async () => 'got it')).resolves.toBe('got it')
    expect(sleep).toHaveBeenCalledWith(5)
  })

  it('does not release a lock another holder took over after the ttl', async () => {
    const client = fakeRedis()
    const locks = redisLocks(client)

    await locks.withLock('k', async () => {
      client.store.set('prow:lock:k', 'a-new-holder')
    })

    expect(client.store.get('prow:lock:k')).toBe('a-new-holder')
  })

  it('gives up after waitMs when the lock never frees, and still releases on a throwing fn', async () => {
    const client = fakeRedis()
    vi.spyOn(sleepModule, 'sleep').mockResolvedValue(undefined)
    client.store.set('prow:lock:k', 'stuck')

    await expect(redisLocks(client, { waitMs: 1, retryMs: 1 }).withLock('k', async () => {})).rejects.toThrow(/could not lock k within 1ms/)

    client.store.clear()
    await expect(redisLocks(client).withLock('k', async () => {
      throw new Error('boom')
    })).rejects.toThrow('boom')
    expect(client.store.has('prow:lock:k')).toBe(false)
  })
})

// a real server: build-test provides one as a service container and sets REDIS_TEST_URL
describe.skipIf(!process.env.REDIS_TEST_URL)('against a redis server', () => {
  const a = createClient({ url: process.env.REDIS_TEST_URL })
  const b = createClient({ url: process.env.REDIS_TEST_URL })
  const prefix = `t${Date.now()}`

  beforeAll(async () => {
    await Promise.all([a.connect(), b.connect()])
  })
  afterAll(async () => {
    await Promise.all([a.close(), b.close()])
  })

  it('dedupes a delivery across two clients', async () => {
    expect(await redisDeliveryStore(a).seen(`${prefix}-d`)).toBe(false)
    expect(await redisDeliveryStore(b).seen(`${prefix}-d`)).toBe(true)
  })

  it('excludes two clients from one pull request at a time', async () => {
    const order: string[] = []
    const la = redisLocks(a, { retryMs: 5 })
    const lb = redisLocks(b, { retryMs: 5 })
    await Promise.all([
      la.withLock(`${prefix}-pr`, async () => {
        order.push('a:start')
        await new Promise(resolve => setTimeout(resolve, 60))
        order.push('a:end')
      }),
      (async () => {
        await new Promise(resolve => setTimeout(resolve, 10))
        await lb.withLock(`${prefix}-pr`, async () => {
          order.push('b:start')
        })
      })(),
    ])
    expect(order).toEqual(['a:start', 'a:end', 'b:start'])
  })

  it('frees a lock whose holder vanished once the ttl passes', async () => {
    await a.set(`prow:lock:${prefix}-dead`, 'gone', { NX: true, PX: 80 })
    await expect(redisLocks(b, { retryMs: 10, waitMs: 1000 }).withLock(`${prefix}-dead`, async () => 'recovered')).resolves.toBe('recovered')
  })
})
