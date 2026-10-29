import type { Context, InputName, Platform } from '../../src/platform'
import { http } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { platform, setPlatform } from '../../src/platform'
import { run } from '../../src/run'
import issueCommentEvent from '../fixtures/issues/issueCommentEvent.json'
import * as utils from '../testUtils'

function memoryPlatform(inputs: Partial<Record<InputName, string>>, context: Context, apiBaseUrl: string) {
  const logs: string[] = []
  const failures: string[] = []
  const log = (level: string) => (message: string) => {
    logs.push(`${level}: ${message}`)
  }
  const fake: Platform = {
    inputs: {
      get: (name, options) => {
        const value = inputs[name] ?? ''
        if (options?.required && value === '') {
          throw new Error(`Input required and not supplied: ${name}`)
        }
        return value
      },
    },
    log: { debug: log('debug'), info: log('info'), notice: log('notice'), warning: log('warning'), error: log('error'), setSecret: () => {} },
    context: () => context,
    apiBaseUrl: () => apiBaseUrl,
    currentWorkflowName: () => undefined,
    fail: message => failures.push(message),
  }
  return { fake, logs, failures }
}

const api = 'https://github.internal/api/v3'
const server = setupServer()

describe('a platform other than GitHub Actions', () => {
  const actions = platform()

  beforeAll(() => {
    server.listen({ onUnhandledRequest: 'error' })
  })
  afterEach(() => {
    server.resetHandlers()
    setPlatform(actions)
  })
  afterAll(() => server.close())

  it('runs /close through run() with no GITHUB_* environment', async () => {
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('GITHUB_') || key.startsWith('INPUT_')) {
        delete process.env[key]
      }
    }
    const payload = structuredClone(issueCommentEvent)
    payload.comment.body = '/close'
    const context = new utils.MockContext(payload)
    context.eventName = 'issue_comment'
    const { fake, failures } = memoryPlatform({ 'github-token': 'memory-token', 'prow-commands': '/close' }, context, api)
    setPlatform(fake)

    const observeReq = new utils.ObserveRequest()
    server.use(
      http.get(`${api}/repos/Codertocat/Hello-World/collaborators/Codertocat`, utils.mockResponse(204)),
      http.patch(`${api}/repos/Codertocat/Hello-World/issues/1`, utils.mockResponse(200, null, observeReq)),
    )

    await run()

    await observeReq.called()
    expect(observeReq.ref?.headers.get('authorization')).toBe('token memory-token')
    expect(await observeReq.body()).toEqual({ state: 'closed' })
    expect(failures).toEqual([])
  })

  it('reports a handler failure through the platform', async () => {
    const payload = structuredClone(issueCommentEvent)
    payload.comment.body = '/close'
    const context = new utils.MockContext(payload)
    context.eventName = 'issue_comment'
    const { fake, failures } = memoryPlatform({ 'prow-commands': '/close' }, context, api)
    setPlatform(fake)

    await run()

    expect(failures).toHaveLength(1)
    expect(failures[0]).toContain('Input required and not supplied: github-token')
  })
})
