import type { FakeGithub } from './fakeGithub'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { start } from './fakeGithub'
import { token } from './helpers'
import { runBundle } from './runBundle'

vi.setConfig({ testTimeout: 30_000 })

// the `jobs` input validation of the cron dispatcher, driven through dist/index.js: the push event routes to the
// cron jobs like schedule and workflow_dispatch do, a blank list fails the run before anything talks to the api,
// and a name the dispatcher does not know fails the run
describe('dist/index.js cron jobs input', () => {
  let gh: FakeGithub

  beforeAll(async () => {
    gh = await start()
  })
  afterEach(() => gh.reset())
  afterAll(() => gh.close())

  it('push without a jobs input fails the run naming the missing list and calls no api', async () => {
    const result = await runBundle({ eventName: 'push', payload: {}, inputs: token, apiUrl: gh.url })

    expect(result.status, result.stdout).toBe(1)
    expect(result.errors.some(e => /please provide a list of space delimited/.test(e))).toBe(true)
    expect(gh.requests).toEqual([])
  })

  it('a jobs input of only whitespace is treated as missing', async () => {
    const result = await runBundle({ eventName: 'schedule', payload: {}, inputs: { ...token, jobs: ' \n\t ' }, apiUrl: gh.url })

    expect(result.status, result.stdout).toBe(1)
    expect(result.errors.some(e => /please provide a list of space delimited/.test(e))).toBe(true)
    expect(gh.requests).toEqual([])
  })

  it('an unknown job name fails the run lowercased, naming the docs, and calls no api', async () => {
    const result = await runBundle({ eventName: 'workflow_dispatch', payload: {}, inputs: { ...token, jobs: 'Tide' }, apiUrl: gh.url })

    expect(result.status, result.stdout).toBe(1)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toContain('could not execute tide')
    expect(gh.requests).toEqual([])
  })
})
