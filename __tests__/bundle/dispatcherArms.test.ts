import type { FakeGithub } from './fakeGithub'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { start } from './fakeGithub'
import { comment, repo, token } from './helpers'
import { runBundle } from './runBundle'

vi.setConfig({ testTimeout: 30_000 })

// the arms of handleIssueComment itself — the prow-commands input and the per-command error isolation —
// driven through dist/index.js like the commands in bundle.test.ts
describe('dist/index.js issue_comment dispatcher', () => {
  let gh: FakeGithub

  beforeAll(async () => {
    gh = await start()
  })
  afterEach(() => gh.reset())
  afterAll(() => gh.close())

  function run(body: string, inputs: Record<string, string>) {
    return runBundle({ eventName: 'issue_comment', payload: comment(body), inputs: { ...token, ...inputs }, apiUrl: gh.url })
  }

  it.each([
    ['missing', {}],
    ['only whitespace', { 'prow-commands': '  \n\t ' }],
  ])('a prow-commands input that is %s fails the run naming the input, with no api call', async (_name, inputs) => {
    const result = await run('/hold', inputs)

    expect(result.status, result.stdout).toBe(1)
    expect(result.errors.some(e => e.includes('please provide a list of space delimited commands / jobs to run'))).toBe(true)
    expect(gh.requests).toEqual([])
  })

  it('one failing command does not stop another in the same body: /remove fails, /hold still applies', async () => {
    gh.route('GET', `${repo}/collaborators/Codertocat`, { status: 404, body: { message: 'Not Found' } })
    gh.route('GET', `${repo}/labels`, { status: 200, body: [{ name: 'do-not-merge/hold' }] })
    gh.route('POST', `${repo}/issues/1/labels`, { status: 200, body: [] })

    const result = await run('/remove foo\n/hold', { 'prow-commands': '/remove /hold' })

    expect(result.status, result.stdout).toBe(1)
    expect(result.errors.some(e => e.includes('commenter is not authorized to remove a label'))).toBe(true)
    expect(gh.requestsMatching('POST', /\/issues\/1\/labels$/)[0].body).toEqual({ labels: ['do-not-merge/hold'] })
  })
})
