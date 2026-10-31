import type { DeliveryStore } from './dedupe'
import type { PullRequestLocks } from './lock'
import type { LogSink } from './platform'

import { sleep } from '../../utils/sleep'

/** the subset of a node-redis client these stores use, so tests can fake it */
export interface RedisLike {
  set: (key: string, value: string, options: { NX?: true, PX?: number, EX?: number }) => Promise<string | null>
  del: (key: string) => Promise<number>
  eval: (script: string, options: { keys: string[], arguments: string[] }) => Promise<unknown>
}

/** how long a claimed delivery stays claimed while its handler runs; a replica that dies mid-delivery frees it after this */
const claimSeconds = 600

/**
 * delivery ids shared by every replica, in two phases: `SET NX` claims the id
 * for the replica that runs it (`processing`, ten minutes), success records it
 * as `done` for the ttl, and a failure deletes it so GitHub's redelivery runs
 */
export function redisDeliveryStore(client: RedisLike, ttlSeconds = 86_400): DeliveryStore {
  const key = (id: string) => `prow:delivery:${id}`
  return {
    async seen(id) {
      const reply = await client.set(key(id), 'processing', { NX: true, EX: claimSeconds })
      return reply === null
    },
    async done(id) {
      await client.set(key(id), 'done', { EX: ttlSeconds })
    },
    async forget(id) {
      await client.del(key(id))
    },
  }
}

/**
 * how long withLock waits for a pull request's lock before giving up. The
 * holder renews its lock while it runs, so this bounds the wait behind a live
 * event (tide's mergeability retries, a slow GitHub) rather than a dead one;
 * five minutes stays inside GitHub's redelivery window and the pod's grace period
 * is not what bounds it.
 */
export const lockWaitMs = 5 * 60_000

export interface RedisLockOptions {
  /** how long a holder may keep the lock without renewing it before it is presumed dead; default 60 s */
  ttlMs?: number
  /** the first wait between acquisition attempts, doubled (with jitter) up to a second; default 50 ms */
  retryMs?: number
  /** give up after this long; default lockWaitMs */
  waitMs?: number
  /** where a failed renewal or release is logged */
  sink?: LogSink
}

// release only what we hold: compare the token, then delete, in one step on the server
const releaseScript = 'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) else return 0 end'
// extend only what we hold, the same way
const renewScript = 'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("pexpire", KEYS[1], ARGV[2]) else return 0 end'

const maxRetryMs = 1_000

/** a lock per pull request shared by every replica, taken with `SET NX PX`, renewed while held and released by its holder */
export function redisLocks(client: RedisLike, options: RedisLockOptions = {}): PullRequestLocks {
  const ttlMs = options.ttlMs ?? 60_000
  const retryMs = options.retryMs ?? 50
  const waitMs = options.waitMs ?? lockWaitMs
  const sink = options.sink ?? (() => {})
  const report = (key: string, step: string, error: unknown) => sink({ level: 'error', message: `redis lock ${key}: ${step} failed: ${error instanceof Error ? error.message : String(error)}` })
  return {
    async withLock(key, fn) {
      const name = `prow:lock:${key}`
      const token = `${Date.now()}-${Math.random().toString(36).slice(2)}`
      const deadline = Date.now() + waitMs
      let backoff = retryMs
      while (await client.set(name, token, { NX: true, PX: ttlMs }) === null) {
        if (Date.now() >= deadline) {
          throw new Error(`could not lock ${key} within ${waitMs}ms`)
        }
        // jitter keeps the replicas waiting on one pull request from retrying in step; never sleep past the deadline
        await sleep(Math.min(Math.round(backoff * (0.5 + Math.random() / 2)), deadline - Date.now()))
        backoff = Math.min(backoff * 2, maxRetryMs)
      }
      // a handler may outlive the ttl (tide's retries, a slow GitHub); renew while it runs so no one else takes the lock
      const renewal = setInterval(() => {
        client.eval(renewScript, { keys: [name], arguments: [token, String(ttlMs)] }).catch(error => report(key, 'renew', error))
      }, Math.max(1, Math.floor(ttlMs / 3)))
      try {
        return await fn()
      }
      finally {
        clearInterval(renewal)
        try {
          await client.eval(releaseScript, { keys: [name], arguments: [token] })
        }
        catch (error) {
          // the lock expires on its own after the ttl; a failed release must not turn a handled event into a failed one
          report(key, 'release', error)
        }
      }
    },
  }
}
