import type { FakeGithub } from './fakeGithub'
import { Buffer } from 'node:buffer'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import labelFileContents from '../fixtures/labels/labelFileContentsResp.json'
import pullReqOpenedEvent from '../fixtures/pullReq/pullReqOpenedEvent.json'
import { start } from './fakeGithub'
import { helpersFor, repo, token } from './helpers'
import { runBundle } from './runBundle'

vi.setConfig({ testTimeout: 30_000 })

// alice approves at the root; bob and carol review sdk/
const ownersFiles: Record<string, string> = {
  'OWNERS': 'approvers:\n- alice\n',
  'sdk/OWNERS': 'reviewers:\n- bob\n- carol\n',
}

function yamlFile(text: string) {
  const file = structuredClone(labelFileContents)
  file.content = Buffer.from(text).toString('base64')
  return file
}

// the configured `blunderbuss:` section driven through dist/index.js on `pull_request opened`: the bundle suite
// otherwise runs blunderbuss at its defaults (and `request_count` through /auto-cc)
describe('dist/index.js blunderbuss settings', () => {
  let gh: FakeGithub
  const { routeOwners } = helpersFor(() => gh)

  beforeAll(async () => {
    gh = await start()
  })
  afterEach(() => gh.reset())
  afterAll(() => gh.close())

  function configure(section: string, pull: Record<string, unknown> = {}) {
    gh.route('GET', '/repos/Codertocat/.project/contents/prow.yaml', { status: 200, body: yamlFile(`blunderbuss:\n${section}`) })
    routeOwners(ownersFiles, ['sdk/x.go'], pull)
    gh.route('POST', `${repo}/pulls/1/requested_reviewers`, { status: 201, body: {} })
  }

  function requested(): string[][] {
    return gh.requestsMatching('POST', /\/pulls\/1\/requested_reviewers$/).map(r => [...(r.body as { reviewers: string[] }).reviewers].sort())
  }

  async function opened() {
    const result = await runBundle({ eventName: 'pull_request', payload: pullReqOpenedEvent, inputs: token, apiUrl: gh.url })
    expect(result.status, result.stdout).toBe(0)
    expect(result.errors).toEqual([])
    return result
  }

  it('ignore_authors skips the pull request of a listed author, matched case-insensitively', async () => {
    configure(`  ignore_authors: ['CODERTOCAT']\n`)

    const result = await opened()

    expect(result.stdout).toContain('blunderbuss: ignoring pull request by codertocat')
    expect(requested()).toEqual([])
  })

  it('exclude_approvers leaves only the reviewers as candidates', async () => {
    configure(`  exclude_approvers: true\n`)

    await opened()

    expect(requested()).toEqual([['bob', 'carol']])
  })

  it.each([
    ['one reviewer is already requested, so one more is picked', ['dave'], 1],
    ['two reviewers are already requested, so nobody is', ['dave', 'erin'], 0],
  ])('max_request_count: 2 caps the request when %s', async (_name, already, picks) => {
    configure(`  max_request_count: 2\n`, { requested_reviewers: already.map(login => ({ login })) })

    const result = await opened()

    const posts = requested()
    expect(posts.flat()).toHaveLength(picks)
    if (picks === 0) {
      expect(result.stdout).toContain(`blunderbuss: #1 already has ${already.length} requested reviewers, max_request_count is 2`)
    }
    else {
      expect(['alice', 'bob', 'carol']).toEqual(expect.arrayContaining(posts[0]))
    }
  })
})
