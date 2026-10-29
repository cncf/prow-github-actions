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
export const globalPlatformScope: PlatformScope = {
  get: () => current,
  run: (value, fn) => {
    const previous = current
    current = value
    try {
      return fn()
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
  const found = scope.get() ?? current
  if (!found) {
    throw new Error('no platform installed: the entry point must call setPlatform() or runWithPlatform() before dispatching an event')
  }
  return found
}
