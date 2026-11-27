import type { FakeGithub } from './fakeGithub'
import { Buffer } from 'node:buffer'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import pullReqOpenedEvent from '../fixtures/pullReq/pullReqOpenedEvent.json'
import { blobSha, prCommentEvent } from '../utils/ownersData'
import { start } from './fakeGithub'
import { comment, configReads, helpersFor, ownersProbe, ownersReads, queueRead, repo, token } from './helpers'
import { runBundle } from './runBundle'

vi.setConfig({ testTimeout: 30_000 })

// the OWNERS-based authorization of a reviewer, driven through dist/index.js: on an issue the root OWNERS file
// of the default branch decides (the membership fallback in bundle.test.ts never reads it), and on a pull
// request the OWNERS covering the changed files refuse a commenter they do not list; the post-command
// needs-* re-check reads the configuration after the command either way
describe('dist/index.js /lgtm authorized by OWNERS files', () => {
  const rootOwnersRead = `GET ${repo}/contents/OWNERS`
  const rootAliasesRead = `GET ${repo}/contents/OWNERS_ALIASES`
  const blobOWNERS = `GET ${repo}/git/blobs/${blobSha('OWNERS')}`
  const blobSdkOWNERS = `GET ${repo}/git/blobs/${blobSha('sdk/OWNERS')}`
  const commentPost = `POST ${repo}/issues/1/comments`
  const labelsRead = `GET ${repo}/labels?per_page=100`
  const labelsPost = `POST ${repo}/issues/1/labels`
  let gh: FakeGithub
  const { calls, expectCommandThenConfig, routeOwners } = helpersFor(() => gh)

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
    expectCommandThenConfig([rootOwnersRead, rootAliasesRead, labelsRead, labelsPost])
  })

  it('on an issue, a commenter the root OWNERS file does not list is refused by name, with no membership fallback', async () => {
    routeRootOwners('reviewers:\n- alice\n')
    gh.route('POST', `${repo}/issues/1/comments`, { status: 201, body: {} })

    const result = await lgtm(comment('/lgtm', 'some-author'))

    expect(result.status, result.stdout).toBe(1)
    expect(result.errors.some(e => e.includes('Codertocat is not included in the reviewers role in the OWNERS file'))).toBe(true)
    expect(comments().some(c => c.includes('Codertocat is not included in the reviewers role in the OWNERS file'))).toBe(true)
    expect(gh.requestsMatching('POST', /\/issues\/1\/labels$/)).toEqual([])
    expectCommandThenConfig([rootOwnersRead, rootAliasesRead, commentPost])
  })

  it('on a pull request, a reviewer the covering OWNERS file lists is authorized by that file alone: labels and binds, no membership read', async () => {
    routeOwners({ 'OWNERS': 'reviewers:\n- bob\n', 'sdk/OWNERS': 'reviewers:\n- alice\n' }, ['sdk/file.go'], { user: { login: 'some-author' } })
    gh.route('POST', `${repo}/statuses/headsha`, { status: 201, body: {} })
    gh.route('GET', `${repo}/labels`, { status: 200, body: [{ name: 'lgtm' }] })
    gh.route('POST', `${repo}/issues/1/labels`, { status: 200, body: [] })

    const result = await lgtm(prCommentEvent('/lgtm', 'alice'))

    expect(result.status, result.stdout).toBe(0)
    expect(result.errors).toEqual([])
    expect(gh.requestsMatching('POST', /\/issues\/1\/labels$/).map(r => r.body)).toEqual([{ labels: ['lgtm'] }])
    expect(gh.requestsMatching('POST', /\/statuses\/headsha$/)[0].body).toMatchObject({ state: 'success', context: 'prow/lgtm', description: 'lgtm by alice at headsha' })
    expect(comments()).toEqual([])
    expect(gh.requestsMatching('GET', /\/contents\/OWNERS$/)).toEqual([])
    expect(gh.requestsMatching('GET', /\/orgs\/|\/collaborators\//)).toEqual([])
    // the owners reads and both OWNERS blobs authorize alice; the configuration is then read once (lgtm.bind_to_commit, memoized
    // for the sweep), the head is bound and labelled, and tide's gate reads the pull request it has yet to see labelled
    const recorded = calls()
    const statusPost = recorded.indexOf(`POST ${repo}/statuses/headsha`)
    expect(recorded.slice(0, statusPost).sort()).toEqual([...ownersReads, blobOWNERS, blobSdkOWNERS, ...configReads()].sort())
    expect(recorded.slice(statusPost)).toEqual([`POST ${repo}/statuses/headsha`, labelsRead, labelsPost, `GET ${repo}/pulls/1`, ownersProbe, queueRead])
  })

  it('on a pull request, a commenter no covering OWNERS file lists is refused: the root file is never read', async () => {
    routeOwners({ 'OWNERS': 'reviewers:\n- alice\n', 'sdk/OWNERS': 'approvers:\n- bob\n' }, ['sdk/file.go'], { user: { login: 'some-author' } })
    gh.route('POST', `${repo}/issues/1/comments`, { status: 201, body: {} })

    const result = await lgtm(prCommentEvent('/lgtm', 'stranger'))

    expect(result.status, result.stdout).toBe(1)
    expect(result.errors.some(e => e.includes('stranger is not a reviewer or approver for any changed file'))).toBe(true)
    expect(comments().some(c => c.includes('stranger is not a reviewer or approver for any changed file'))).toBe(true)
    expect(gh.requestsMatching('POST', /\/issues\/1\/labels$/)).toEqual([])
    expect(gh.requestsMatching('GET', /\/contents\/OWNERS$/)).toEqual([])
    expect(gh.requestsMatching('GET', /\/orgs\/|\/collaborators\//)).toEqual([])
    // the owners reads, the two OWNERS blobs, the refusal, then the config reads and tide's gate on the pull request
    expectCommandThenConfig(
      [commentPost],
      [`GET ${repo}/pulls/1`, ownersProbe, queueRead],
      [...ownersReads, blobOWNERS, blobSdkOWNERS],
    )
  })
})
