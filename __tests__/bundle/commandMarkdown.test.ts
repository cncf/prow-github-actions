import type { FakeGithub } from './fakeGithub'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { start } from './fakeGithub'
import { comment, configReads, helpersFor, repo, token } from './helpers'
import { runBundle } from './runBundle'

vi.setConfig({ testTimeout: 30_000 })

// src/utils/command.ts commandLines: the Markdown that cannot carry a command, driven through dist/index.js.
// bundle.test.ts already shows a /kind inside an unclosed ``` fence is ignored; these are the arms it leaves
// unreached in the bundle — a fence that closes (and the lines that do not close it), indented code, and a
// backtick fence whose info string disqualifies it. /hold is the probe: it reads the repository's labels and
// posts do-not-merge/hold when it fires, and touches nothing when it does not.
describe('dist/index.js issue_comment commands inside Markdown code', () => {
  let gh: FakeGithub
  const { expectRequests } = helpersFor(() => gh)

  const labelsRead = `GET ${repo}/labels?per_page=100`
  const labelsPost = `POST ${repo}/issues/1/labels`

  beforeAll(async () => {
    gh = await start()
  })
  afterEach(() => gh.reset())
  afterAll(() => gh.close())

  function run(body: string) {
    return runBundle({ eventName: 'issue_comment', payload: comment(body), inputs: { ...token, 'prow-commands': '/hold' }, apiUrl: gh.url })
  }

  function routeHold() {
    gh.route('GET', `${repo}/labels`, { status: 200, body: [{ name: 'do-not-merge/hold' }] })
    gh.route('POST', `${repo}/issues/1/labels`, { status: 200, body: [] })
  }

  it.each([
    ['a ``` opener whose info string holds a backtick, which is not a fence', '```not`a`fence\n/hold'],
    ['an indented line continuing a paragraph, which is not code', 'please\n    /hold'],
  ])('applies the /hold that follows %s, once', async (_name, body) => {
    routeHold()

    const result = await run(body)

    expect(result.status, result.stdout).toBe(0)
    expect(result.errors).toEqual([])
    const posts = gh.requestsMatching('POST', /\/issues\/1\/labels$/)
    expect(posts).toHaveLength(1)
    expect(posts[0].body).toEqual({ labels: ['do-not-merge/hold'] })
    expectRequests(configReads(), [labelsRead, labelsPost])
  })

  it.each([
    ['indented code after a blank line', 'quoting:\n\n    /hold'],
  ])('ignores a /hold inside %s without calling the api', async (_name, body) => {
    const result = await run(body)

    expect(result.status, result.stdout).toBe(0)
    expect(result.errors).toEqual([])
    expect(gh.requests).toEqual([])
  })
})
