import type { FakeGithub } from './fakeGithub'
import { Buffer } from 'node:buffer'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import pullReqOpenedEvent from '../fixtures/pullReq/pullReqOpenedEvent.json'
import { blobSha, prCommentEvent } from '../utils/ownersFixtures'
import { start } from './fakeGithub'
import { comment, helpersFor, ownersProbe, ownersReads, queueRead, repo, token } from './helpers'
import { runBundle } from './runBundle'

vi.setConfig({ testTimeout: 30_000 })

// the OWNERS-based authorization of a reviewer, driven through dist/index.js: on an issue the root OWNERS file
// of the default branch decides (the membership fallback in bundle.test.ts never reads it), and on a pull
// request the OWNERS covering the changed files refuse a commenter they do not list; the post-command
// needs-* re-check reads the configuration after the command either way
describe('dist/index.js /lgtm authorized by OWNERS files', () => {
  const rootOwnersRead = `GET ${repo}/contents/OWNERS`
  const commentPost = `POST ${repo}/issues/1/comments`
  const labelsRead = `GET ${repo}/labels?per_page=100`
  const labelsPost = `POST ${repo}/issues/1/labels`
  let gh: FakeGithub
  const { expectCommandThenConfig, routeOwners } = helpersFor(() => gh)

  beforeAll(async () => {
    gh = await start()
  })
  beforeEach(() => gh.mergeQueueFallback({ pullRequestId: 'PR_none', headOid: pullReqOpenedEvent.pull_request.head.sha, enabled: false }))
  afterEach(() => gh.reset())
  afterAll(() => gh.close())

  function routeRootOwners(contents: string) {
    gh.route('GET', `${repo}/contents/OWNERS`, {
      status: 200,
      body: { encoding: 'base64', content: Buffer.from(contents).toString('base64') },
    })
  }

  function lgtm(payload: Record<string, unknown>) {
    return runBundle({ eventName: 'issue_comment', payload, inputs: { ...token, 'prow-commands': '/lgtm' }, apiUrl: gh.url })
  }

  function comments() {
    return gh.requestsMatching('POST', /\/issues\/1\/comments$/).map(r => (r.body as { body: string }).body)
  }

  it('on an issue, a reviewer listed in the root OWNERS file is authorized by that file alone: no membership read', async () => {
    routeRootOwners('reviewers:\n- codertocat\n')
    gh.route('GET', `${repo}/labels`, { status: 200, body: [{ name: 'lgtm' }] })
    gh.route('POST', `${repo}/issues/1/labels`, { status: 200, body: [] })

    const result = await lgtm(comment('/lgtm', 'some-author'))

    expect(result.status, result.stdout).toBe(0)
    expect(result.errors).toEqual([])
    expect(gh.requestsMatching('POST', /\/issues\/1\/labels$/).map(r => r.body)).toEqual([{ labels: ['lgtm'] }])
    expectCommandThenConfig([rootOwnersRead, labelsRead, labelsPost])
  })

  it('on an issue, a commenter the root OWNERS file does not list is refused by name, with no membership fallback', async () => {
    routeRootOwners('reviewers:\n- alice\n')
    gh.route('POST', `${repo}/issues/1/comments`, { status: 201, body: {} })

    const result = await lgtm(comment('/lgtm', 'some-author'))

    expect(result.status, result.stdout).toBe(1)
    expect(result.errors.some(e => e.includes('Codertocat is not included in the reviewers role in the OWNERS file'))).toBe(true)
    expect(comments()).toEqual(['Cannot apply the lgtm label because Error: Codertocat is not included in the reviewers role in the OWNERS file'])
    expect(gh.requestsMatching('POST', /\/issues\/1\/labels$/)).toEqual([])
    expectCommandThenConfig([rootOwnersRead, commentPost])
  })

  it('on a pull request, a commenter no covering OWNERS file lists is refused: the root file is never read', async () => {
    routeOwners({ 'OWNERS': 'reviewers:\n- alice\n', 'sdk/OWNERS': 'approvers:\n- bob\n' }, ['sdk/file.go'], { user: { login: 'some-author' } })
    gh.route('POST', `${repo}/issues/1/comments`, { status: 201, body: {} })

    const result = await lgtm(prCommentEvent('/lgtm', 'stranger'))

    expect(result.status, result.stdout).toBe(1)
    expect(result.errors.some(e => e.includes('stranger is not a reviewer or approver for any changed file'))).toBe(true)
    expect(comments()).toEqual(['Cannot apply the lgtm label because Error: stranger is not a reviewer or approver for any changed file'])
    expect(gh.requestsMatching('POST', /\/issues\/1\/labels$/)).toEqual([])
    expect(gh.requestsMatching('GET', /\/contents\/OWNERS$/)).toEqual([])
    expect(gh.requestsMatching('GET', /\/orgs\/|\/collaborators\//)).toEqual([])
    // the owners reads, the two OWNERS blobs, the refusal, then the config reads and tide's gate on the pull request
    expectCommandThenConfig(
      [`GET ${repo}/git/blobs/${blobSha('OWNERS')}`, `GET ${repo}/git/blobs/${blobSha('sdk/OWNERS')}`, commentPost],
      [`GET ${repo}/pulls/1`, ownersProbe, queueRead],
      ownersReads,
    )
  })
})
