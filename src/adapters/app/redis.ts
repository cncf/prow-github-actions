import type { DeliveryStore } from './dedupe'
import type { PullRequestLocks } from './lock'

import { sleep } from '../../utils/sleep'

/** the subset of a node-redis client these stores use, so tests can fake it */
export interface RedisLike {
  set: (key: string, value: string, options: { NX: true, PX?: number, EX?: number }) => Promise<string | null>
  eval: (script: string, options: { keys: string[], arguments: string[] }) => Promise<unknown>
}

/** delivery ids shared by every replica; `SET NX` makes the first writer the only handler */
export function redisDeliveryStore(client: RedisLike, ttlSeconds = 86_400): DeliveryStore {
  return {
    async seen(id) {
      const reply = await client.set(`prow:delivery:${id}`, '1', { NX: true, EX: ttlSeconds })
      return reply === null
    },
  }
}

export interface RedisLockOptions {
  /** how long a holder may keep the lock before it is presumed dead; default 60 s */
  ttlMs?: number
  /** how long to wait between acquisition attempts; default 50 ms */
  retryMs?: number
  /** give up after this long; default the ttl, so a dead holder's lock is waited out exactly once */
  waitMs?: number
}

// release only what we hold: compare the token, then delete, in one step on the server
const releaseScript = 'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end'

/** a lock per pull request shared by every replica, taken with `SET NX PX` and released by its holder */
export function redisLocks(client: RedisLike, options: RedisLockOptions = {}): PullRequestLocks {
  const ttlMs = options.ttlMs ?? 60_000
  const retryMs = options.retryMs ?? 50
  const waitMs = options.waitMs ?? ttlMs
  return {
    async withLock(key, fn) {
      const name = `prow:lock:${key}`
      const token = `${Date.now()}-${Math.random().toString(36).slice(2)}`
      const deadline = Date.now() + waitMs
      while (await client.set(name, token, { NX: true, PX: ttlMs }) === null) {
        if (Date.now() >= deadline) {
          throw new Error(`could not lock ${key} within ${waitMs}ms`)
        }
        await sleep(retryMs)
      }
      try {
        return await fn()
      }
      finally {
        await client.eval(releaseScript, { keys: [name], arguments: [token] })
      }
    },
  }
}
