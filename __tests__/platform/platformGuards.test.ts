import type { PlatformScope } from '../../src/platform'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// The two arms of platform() that runState.test.ts never reaches: the throw
// when nothing has installed a platform, and the fall-back to the process-wide
// value when an installed scope has no platform for the current work (an
// adapter's AsyncLocalStorage outside any run). Each case imports src/platform
// fresh so that neither the empty slot nor the installed scope leaks into the
// platform setup.ts gives every other test.

beforeEach(() => vi.resetModules())
afterEach(() => vi.resetModules())

async function freshPlatformModule() {
  return import('../../src/platform')
}

describe('platform()', () => {
  it('throws, naming both installers, when no platform has been installed', async () => {
    const { platform } = await freshPlatformModule()

    expect(() => platform()).toThrow(new Error('no platform installed: the entry point must call setPlatform() or runWithPlatform() before dispatching an event'))
  })

  it('falls back to the process-wide platform when the installed scope has none for the current work', async () => {
    const { actionsPlatform } = await import('../../src/adapters/actions')
    const { installPlatformScope, platform, setPlatform } = await freshPlatformModule()
    const processWide = actionsPlatform()
    const scoped = actionsPlatform()
    let inRun = false
    const scope: PlatformScope = {
      get: () => (inRun ? scoped : undefined),
      run: (_value, fn) => {
        inRun = true
        try {
          return fn()
        }
        finally {
          inRun = false
        }
      },
    }
    installPlatformScope(scope)
    setPlatform(processWide)

    expect(platform()).toBe(processWide)
    expect(scope.run(scoped, () => platform())).toBe(scoped)
    expect(platform()).toBe(processWide)
  })

  it('still throws under an installed scope when neither it nor the process has a platform', async () => {
    const { installPlatformScope, platform } = await freshPlatformModule()
    installPlatformScope({ get: () => undefined, run: (_value, fn) => fn() })

    expect(() => platform()).toThrow('no platform installed')
  })
})
