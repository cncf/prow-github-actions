import type { Platform } from './types'

export * from './types'

/**
 * PlatformScope decides which Platform `platform()` answers with. The default
 * is a single process-wide value, which is right for a GitHub Actions run; an
 * adapter handling many events at once installs one backed by
 * AsyncLocalStorage so that each event sees its own.
 */
export interface PlatformScope {
  get: () => Platform | undefined
  run: <T>(value: Platform, fn: () => T) => T
}

let current: Platform | undefined

/* v8 ignore start -- scoping is for adapters handling concurrent events; the action never reaches it from dist/index.js */
/**
 * The process-wide scope holds its platform only until `fn` returns, which for
 * an async function is its first `await`: the rest would run under whatever
 * platform is current then, or none. It refuses a promise rather than let that
 * happen; async work needs an installed scope that follows it (`asyncLocalScope`).
 */
export const globalPlatformScope: PlatformScope = {
  get: () => current,
  run: (value, fn) => {
    const previous = current
    current = value
    try {
      const result = fn()
      if (result instanceof Promise) {
        throw new TypeError('runWithPlatform was given async work under the process-wide platform scope, which ends at its first await: install a scope that follows async work (asyncLocalScope) first')
      }
      return result
    }
    finally {
      current = previous
    }
  },
}

let scope: PlatformScope = globalPlatformScope

export function installPlatformScope(next: PlatformScope): void {
  scope = next
}

export function runWithPlatform<T>(value: Platform, fn: () => T): T {
  return scope.run(value, fn)
}
/* v8 ignore stop */

export function setPlatform(next: Platform): void {
  current = next
}

export function platform(): Platform {
  /* v8 ignore next -- the process-wide scope answers with `current` itself, so the `?? current` fallback is unreachable from dist/index.js; platformGuards.test.ts drives it */
  const found = scope.get() ?? current
  /* v8 ignore if -- main.ts installs the platform before anything dispatches, so the guard is unreachable from dist/index.js; platformGuards.test.ts drives it */
  if (!found) {
    throw new Error('no platform installed: the entry point must call setPlatform() or runWithPlatform() before dispatching an event')
  }
  return found
}
