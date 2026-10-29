import type { Platform, PlatformScope } from '../../platform'
import { AsyncLocalStorage } from 'node:async_hooks'

export function asyncLocalScope(): PlatformScope {
  const storage = new AsyncLocalStorage<Platform>()
  return {
    get: () => storage.getStore(),
    run: (value, fn) => storage.run(value, fn),
  }
}
