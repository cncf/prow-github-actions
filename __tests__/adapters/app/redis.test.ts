import type { RedisLike } from '../../../src/adapters/app/redis'
import process from 'node:process'
import { createClient } from 'redis'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

import { lockWaitMs, redisDeliveryStore, redisLocks } from '../../../src/adapters/app/redis'
import * as sleepModule from '../../../src/utils/sleep'

/** an in-memory SET / DEL / EVAL that is good enough for the scripts the stores use: release (one argument) and renew (two) */
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
    async del(key) {
      calls.push(`del ${key}`)
      return store.delete(key) ? 1 : 0
    },
    async eval(_script, { keys, arguments: args }) {
      const renew = args.length === 2
      calls.push(renew ? `renew ${keys[0]} ${args[1]}` : `eval ${keys[0]}`)
      if (store.get(keys[0]!) === args[0]) {
        if (!renew) {
          store.delete(keys[0]!)
        }
        return 1
      }
      return 0
    },
  }
}

describe('redisDeliveryStore', () => {
  it('claims an id for ten minutes, so it is seen while its handler runs', async () => {
    const client = fakeRedis()
    const store = redisDeliveryStore(client, 123)

    expect(await store.seen('a')).toBe(false)
    expect(await store.seen('a')).toBe(true)
    expect(await store.seen('b')).toBe(false)
    expect(client.calls[0]).toBe('set prow:delivery:a {"NX":true,"EX":600}')
    expect(client.store.get('prow:delivery:a')).toBe('processing')
  })

  it('records a handled id as done for the ttl, a day by default', async () => {
    const client = fakeRedis()

    await redisDeliveryStore(client, 123).done!('a')
    await redisDeliveryStore(client).done!('b')

    expect(client.calls).toEqual(['set prow:delivery:a {"EX":123}', 'set prow:delivery:b {"EX":86400}'])
    expect(client.store.get('prow:delivery:a')).toBe('done')
    expect(await redisDeliveryStore(client).seen('a')).toBe(true)
  })

  it('forgets a failed id, so its redelivery is claimed again', async () => {
    const client = fakeRedis()
    const store = redisDeliveryStore(client)
    await store.seen('a')

    await store.forget!('a')

    expect(client.calls.at(-1)).toBe('del prow:delivery:a')
    expect(await store.seen('a')).toBe(false)
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

  it('waits for a held lock with a doubling, jittered backoff, then takes it', async () => {
    const client = fakeRedis()
    vi.spyOn(Math, 'random').mockReturnValue(0)
    const sleep = vi.spyOn(sleepModule, 'sleep').mockImplementation(async () => {
      if (sleep.mock.calls.length === 3) {
        client.store.delete('prow:lock:k')
      }
    })
    client.store.set('prow:lock:k', 'someone-else')

    await expect(redisLocks(client).withLock('k', async () => 'got it')).resolves.toBe('got it')
    // half of 50, 100, 200 ms: the jitter takes between half and all of each step
    expect(sleep.mock.calls).toEqual([[25], [50], [100]])
  })

  it('caps the backoff at a second', async () => {
    const client = fakeRedis()
    vi.spyOn(Math, 'random').mockReturnValue(0.999)
    const sleep = vi.spyOn(sleepModule, 'sleep').mockImplementation(async () => {
      if (sleep.mock.calls.length === 3) {
        client.store.delete('prow:lock:k')
      }
    })
    client.store.set('prow:lock:k', 'someone-else')

    await redisLocks(client, { retryMs: 600 }).withLock('k', async () => {})

    expect(sleep.mock.calls).toEqual([[600], [1000], [1000]])
  })

  it('waits five minutes for a held lock by default before giving up', async () => {
    const client = fakeRedis()
    let now = 1_000_000
    vi.spyOn(Date, 'now').mockImplementation(() => now)
    vi.spyOn(sleepModule, 'sleep').mockImplementation(async (ms) => {
      now += ms
    })
    client.store.set('prow:lock:k', 'stuck')

    await expect(redisLocks(client).withLock('k', async () => {})).rejects.toThrow('could not lock k within 300000ms')
    expect(lockWaitMs).toBe(300_000)
    expect(now).toBeGreaterThanOrEqual(1_000_000 + lockWaitMs)
  })

  it('renews the lock every third of the ttl while fn runs, and stops once it returns', async () => {
    vi.useFakeTimers()
    try {
      const client = fakeRedis()
      let finish!: () => void
      const running = redisLocks(client, { ttlMs: 300 }).withLock('k', () => new Promise<void>((resolve) => {
        finish = resolve
      }))
      await vi.advanceTimersByTimeAsync(250)
      expect(client.calls.filter(call => call.startsWith('renew'))).toEqual(['renew prow:lock:k 300', 'renew prow:lock:k 300'])

      finish()
      await running
      await vi.advanceTimersByTimeAsync(1_000)
      expect(client.calls.filter(call => call.startsWith('renew'))).toHaveLength(2)
      expect(client.calls.at(-1)).toBe('eval prow:lock:k')
    }
    finally {
      vi.useRealTimers()
    }
  })

  it('logs a renewal that fails and keeps running fn', async () => {
    vi.useFakeTimers()
    try {
      const client = fakeRedis()
      const lines: Record<string, unknown>[] = []
      const release = client.eval.bind(client)
      client.eval = async (script, options) => {
        if (options.arguments.length === 2) {
          throw new Error('connection lost')
        }
        return release(script, options)
      }
      const running = redisLocks(client, { ttlMs: 30, sink: line => lines.push(line) }).withLock('k', async () => {
        await new Promise(resolve => setTimeout(resolve, 15))
        return 'done'
      })
      await vi.advanceTimersByTimeAsync(15)

      await expect(running).resolves.toBe('done')
      expect(lines).toEqual([{ level: 'error', message: 'redis lock k: renew failed: connection lost' }])
    }
    finally {
      vi.useRealTimers()
    }
  })

  it('logs a release that fails instead of failing the handled event, and names a non-Error by its string form', async () => {
    const client = fakeRedis()
    const lines: Record<string, unknown>[] = []
    // eslint-disable-next-line prefer-promise-reject-errors
    client.eval = () => Promise.reject('offline')

    await expect(redisLocks(client, { sink: line => lines.push(line) }).withLock('k', async () => 'handled')).resolves.toBe('handled')
    await expect(redisLocks(client).withLock('j', async () => 'handled without a sink')).resolves.toBe('handled without a sink')

    expect(lines).toEqual([{ level: 'error', message: 'redis lock k: release failed: offline' }])
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

  it('dedupes a delivery across two clients, keeps it a day once done, and frees it once forgotten', async () => {
    expect(await redisDeliveryStore(a).seen(`${prefix}-d`)).toBe(false)
    expect(await redisDeliveryStore(b).seen(`${prefix}-d`)).toBe(true)
    expect(await a.ttl(`prow:delivery:${prefix}-d`)).toBeLessThanOrEqual(600)

    await redisDeliveryStore(a).done!(`${prefix}-d`)
    expect(await b.get(`prow:delivery:${prefix}-d`)).toBe('done')
    expect(await b.ttl(`prow:delivery:${prefix}-d`)).toBeGreaterThan(600)

    await redisDeliveryStore(a).forget!(`${prefix}-d`)
    expect(await redisDeliveryStore(b).seen(`${prefix}-d`)).toBe(false)
  })

  it('keeps a lock held past its ttl while the holder runs', async () => {
    const holding = redisLocks(a, { ttlMs: 150 }).withLock(`${prefix}-long`, async () => {
      await new Promise(resolve => setTimeout(resolve, 450))
      return 'held'
    })
    await new Promise(resolve => setTimeout(resolve, 20))

    await expect(redisLocks(b, { retryMs: 10, waitMs: 300 }).withLock(`${prefix}-long`, async () => 'stolen')).rejects.toThrow(/could not lock/)
    await expect(holding).resolves.toBe('held')
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
