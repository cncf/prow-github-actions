import type { Platform, PlatformScope } from '../../src/platform'
import { AsyncLocalStorage } from 'node:async_hooks'
import { http } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { actionsPlatform } from '../../src/adapters/actions'
import { globalPlatformScope, installPlatformScope, newRunState, platform, runWithPlatform, setPlatform } from '../../src/platform'
import { loadProwConfig } from '../../src/utils/config'
import { newOctokit } from '../../src/utils/octokit'
import pullReqOpenedEvent from '../fixtures/pullReq/pullReqOpenedEvent.json'
import * as utils from '../testUtils'

const server = setupServer()
utils.failTestOnUnhandledRequests(server)

function withState(): Platform {
  const base = actionsPlatform()
  const state = newRunState()
  return { ...base, state: () => state }
}

describe('runState', () => {
  beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
  afterEach(() => server.resetHandlers())
  afterAll(() => server.close())

  it('starts empty', () => {
    const state = newRunState()
    for (const value of Object.values(state)) {
      expect(value.size).toBe(0)
    }
  })

  it('is one per platform: two runs load the same repository\'s configuration separately', async () => {
    utils.setupActionsEnv()
    const context = new utils.MockContext(pullReqOpenedEvent)
    const octokit = newOctokit('token')
    let reads = 0
    server.use(
      http.get(utils.contentsUrl('.github/prow.yaml'), () => {
        reads++
        return new Response(JSON.stringify({ content: btoa('kind: [bug]\n'), encoding: 'base64' }), { headers: { 'Content-Type': 'application/json' } })
      }),
      ...utils.noOrgOrRepoConfigExcept('.github/prow.yaml'),
    )

    const first = withState()
    const second = withState()
    await runWithPlatform(first, () => loadProwConfig(octokit, context))
    await runWithPlatform(first, () => loadProwConfig(octokit, context))
    expect(reads).toBe(1)
    expect(first.state().configs.size).toBe(1)

    await runWithPlatform(second, () => loadProwConfig(octokit, context))
    expect(reads).toBe(2)
    expect(second.state().configs.size).toBe(1)
  })

  it('runWithPlatform restores the outer platform, including after a throw', () => {
    const outer = withState()
    const inner = withState()
    setPlatform(outer)

    expect(runWithPlatform(inner, () => platform())).toBe(inner)
    expect(platform()).toBe(outer)
    expect(() => runWithPlatform(inner, () => {
      throw new Error('boom')
    })).toThrow('boom')
    expect(platform()).toBe(outer)
  })

  it('an installed scope decides which platform concurrent work sees', async () => {
    const storage = new AsyncLocalStorage<Platform>()
    const scope: PlatformScope = { get: () => storage.getStore(), run: (value, fn) => storage.run(value, fn) }
    const a = withState()
    const b = withState()
    installPlatformScope(scope)
    try {
      const seen = await Promise.all([
        runWithPlatform(a, async () => {
          await new Promise(resolve => setTimeout(resolve, 5))
          return platform()
        }),
        runWithPlatform(b, async () => platform()),
      ])
      expect(seen).toEqual([a, b])
    }
    finally {
      installPlatformScope(globalPlatformScope)
    }
  })
})
