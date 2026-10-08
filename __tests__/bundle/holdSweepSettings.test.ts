import type { FakeGithub } from './fakeGithub'
import { Buffer } from 'node:buffer'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import labelFileContents from '../fixtures/labels/labelFileContentsResp.json'
import { start } from './fakeGithub'
import { comment, configReads, helpersFor, repo, token } from './helpers'
import { runBundle } from './runBundle'

vi.setConfig({ testTimeout: 30_000 })

// the `hold` and `sweep` sections of prow.yaml, driven through dist/index.js: a configured `hold.label`
// on /hold and /hold cancel, a configured `sweep.lookback` (and its 24h cap) on the sweep job's window,
// and the refusals of each section's normalizer
describe('dist/index.js configured hold and sweep sections', () => {
  let gh: FakeGithub
  const { expectRequests } = helpersFor(() => gh)

  const source = 'Codertocat/Hello-World:.github/prow.yaml'
  const reads = configReads({ repo: '.github/prow.yaml' })
  const labelsRead = `GET ${repo}/labels?per_page=100`
  const listPage = `GET ${repo}/pulls?state=open&sort=updated&direction=desc&per_page=100&page=1`

  beforeAll(async () => {
    gh = await start()
  })
  afterEach(() => gh.reset())
  afterAll(() => gh.close())

  function routeConfig(yaml: string) {
    const file = structuredClone(labelFileContents)
    file.content = Buffer.from(yaml).toString('base64')
    gh.route('GET', `${repo}/contents/${encodeURIComponent('.github/prow.yaml')}`, { status: 200, body: file })
  }

  function runHold(body: string) {
    return runBundle({ eventName: 'issue_comment', payload: comment(body), inputs: { ...token, 'prow-commands': '/hold' }, apiUrl: gh.url })
  }

  function runSweep() {
    gh.route('GET', new RegExp(`^${repo}/pulls\\?`), { status: 200, body: [] })
    return runBundle({ eventName: 'schedule', payload: {}, inputs: { ...token, jobs: 'sweep' }, apiUrl: gh.url })
  }

  // the sweep's `since` is `lookback` before the child's own clock, which ticks somewhere between the run's start and end
  async function expectWindow(lookbackMs: number) {
    const started = Date.now()
    const result = await runSweep()
    const finished = Date.now()

    expect(result.status, result.stdout).toBe(0)
    expect(result.errors).toEqual([])
    const since = /sweep: 0 candidates updated since (\S+)/.exec(result.stdout)?.[1]
    expect(since, result.stdout).toBeDefined()
    expect(new Date(since!).getTime()).toBeGreaterThanOrEqual(started - lookbackMs)
    expect(new Date(since!).getTime()).toBeLessThanOrEqual(finished - lookbackMs)
  }

  describe('hold.label', () => {
    it('/hold applies the configured label instead of do-not-merge/hold', async () => {
      routeConfig('hold:\n  label: needs-hold\n')
      gh.route('GET', `${repo}/labels`, { status: 200, body: [{ name: 'needs-hold' }] })
      gh.route('POST', `${repo}/issues/1/labels`, { status: 200, body: [] })

      const result = await runHold('/hold')

      expect(result.status, result.stdout).toBe(0)
      expect(result.errors).toEqual([])
      const posts = gh.requestsMatching('POST', /\/issues\/1\/labels$/)
      expect(posts).toHaveLength(1)
      expect(posts[0].body).toEqual({ labels: ['needs-hold'] })
      expectRequests(reads, [labelsRead, `POST ${repo}/issues/1/labels`])
    })

    it.each([
      ['hold: []\n', 'hold must be a mapping'],
      ['hold:\n  label: ""\n', 'hold.label must be a non-empty string'],
    ])('refuses %j: %s', async (yaml, message) => {
      routeConfig(yaml)

      const result = await runHold('/hold')

      expect(result.status, result.stdout).toBe(1)
      expect(result.errors.some(e => e.includes(`${source}: ${message}`)), result.errors.join('\n')).toBe(true)
      // the configuration is refused before any label is read or written
      expectRequests(reads, [])
    })
  })

  describe('sweep.lookback', () => {
    it('sets the window the sweep lists pull requests for', async () => {
      routeConfig('sweep:\n  lookback: 30m\n')

      await expectWindow(30 * 60_000)

      // an empty window: the configuration and the page, nothing per pull request
      expectRequests(reads, [listPage])
    })

    it.each([
      ['sweep: 5\n', 'sweep must be a mapping'],
      ['sweep:\n  lookback: 30\n', 'sweep.lookback must be a duration string such as 1h or 30m'],
      ['sweep:\n  lookback: soon\n', 'invalid sweep.lookback \'soon\': expected a duration such as 5s, 2m or 500ms'],
      ['sweep:\n  lookback: 0m\n', 'sweep.lookback must be longer than 0'],
    ])('refuses %j: %s', async (yaml, message) => {
      routeConfig(yaml)

      const result = await runSweep()

      expect(result.status, result.stdout).toBe(1)
      expect(result.errors.some(e => e.includes(`${source}: ${message}`)), result.errors.join('\n')).toBe(true)
      // the configuration is refused before the sweep lists anything
      expectRequests(reads, [])
    })
  })
})
