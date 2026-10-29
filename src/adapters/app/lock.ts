import type { Delivery } from './platform'

/**
 * PullRequestLocks runs the events of one pull request one after another, as
 * the action's `concurrency:` group does, so that two events arriving together
 * do not race the merge gate.
 */
export interface PullRequestLocks {
  withLock: <T>(key: string, fn: () => Promise<T>) => Promise<T>
}

/** the lock key of a delivery: `owner/repo#number`, or undefined for an event about no issue or pull request */
export function pullRequestKey(delivery: Delivery): string | undefined {
  const number: unknown = delivery.payload.pull_request?.number ?? delivery.payload.issue?.number
  const repository = delivery.payload.repository
  if (typeof number !== 'number' || !repository?.full_name) {
    return undefined
  }
  return `${repository.full_name}#${number}`
}

/** one process: a promise chain per key */
export function memoryLocks(): PullRequestLocks {
  const tails = new Map<string, Promise<unknown>>()
  return {
    async withLock(key, fn) {
      const previous = tails.get(key) ?? Promise.resolve()
      const own = previous.then(fn, fn)
      const settled = own.then(() => undefined, () => undefined)
      tails.set(key, settled)
      try {
        return await own
      }
      finally {
        if (tails.get(key) === settled) {
          tails.delete(key)
        }
      }
    },
  }
}
