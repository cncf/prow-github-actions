import type { FakeGithub } from './fakeGithub'
import { Buffer } from 'node:buffer'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import pullReqOpenedEvent from '../fixtures/pullReq/pullReqOpenedEvent.json'
import { blobSha, prCommentEvent } from '../utils/ownersData'
import { start } from './fakeGithub'
import { comment, configReads, helpersFor, membershipReads, ownersReads, repo, token } from './helpers'
import { runBundle } from './runBundle'

vi.setConfig({ testTimeout: 30_000 })

// Root `OWNERS_ALIASES` expansion (src/utils/owners.ts: parseOwnersAliases, expandAliases,
// loadOwnersTree, probeOwners, expandOwnersSet, ownersInclude; src/utils/auth.ts: retrieveOwnersAliases),
// driven through dist/index.js across /lgtm, /approve ([APPROVALNOTIFIER] + suggestApprovers),
// blunderbuss, issue root OWNERS, authorization.labels: trusted, truncated-tree probes, and fail-closed
// parse/API errors.
describe('dist/index.js OWNERS_ALIASES', () => {
  const rootOwnersRead = `GET ${repo}/contents/OWNERS`
  const rootAliasesRead = `GET ${repo}/contents/OWNERS_ALIASES`
  const labelsRead = `GET ${repo}/labels?per_page=100`
  const labelsPost = `POST ${repo}/issues/1/labels`
  const commentPost = `POST ${repo}/issues/1/comments`
  const prowYamlPath = `${repo}/contents/${encodeURIComponent('.github/prow.yaml')}`
  const notFound = { status: 404, body: { message: 'Not Found' } }
  let gh: FakeGithub
  const { calls, expectCommandThenConfig, expectRequests, routeOwners } = helpersFor(() => gh)

  beforeAll(async () => {
    gh = await start()
  })
  beforeEach(() => gh.mergeQueueFallback({ pullRequestId: 'PR_none', headOid: pullReqOpenedEvent.pull_request.head.sha, enabled: false }))
  afterEach(() => gh.reset())
  afterAll(() => gh.close())

  function contentsBody(text: string) {
    return { status: 200, body: { type: 'file', encoding: 'base64', content: Buffer.from(text).toString('base64') } }
  }

  function routeRootFile(path: 'OWNERS' | 'OWNERS_ALIASES', text: string) {
    gh.route('GET', `${repo}/contents/${path}`, contentsBody(text))
  }

  function routeLabelWrite(label = 'lgtm') {
    gh.route('GET', `${repo}/labels`, { status: 200, body: [{ name: label }] })
    gh.route('POST', `${repo}/issues/1/labels`, { status: 200, body: [] })
  }

  function lgtm(payload: Record<string, unknown>) {
    return runBundle({ eventName: 'issue_comment', payload, inputs: { ...token, 'prow-commands': '/lgtm' }, apiUrl: gh.url })
  }

  function approve(payload: Record<string, unknown>) {
    return runBundle({ eventName: 'issue_comment', payload, inputs: { ...token, 'prow-commands': '/approve' }, apiUrl: gh.url })
  }

  it('on a pull request, authorizes /lgtm via OWNERS_ALIASES with one blob fetch and zero team calls', async () => {
    routeOwners(
      {
        'OWNERS_ALIASES': 'aliases:\n  API-Reviewers:\n    - Alice\n    - carol\n  empty-group:\n',
        'sdk/OWNERS': 'reviewers:\n- api-reviewers\n- empty-group\n',
      },
      ['sdk/a.go', 'sdk/b.go'],
      { user: { login: 'some-author' } },
    )
    gh.route('POST', `${repo}/statuses/headsha`, { status: 201, body: {} })
    routeLabelWrite()

    const result = await lgtm(prCommentEvent('/lgtm', 'alice'))

    expect(result.status, result.stdout).toBe(0)
    expect(result.errors).toEqual([])
    expect(gh.requestsMatching('POST', /\/issues\/1\/labels$/).map(r => r.body)).toEqual([{ labels: ['lgtm'] }])
    expect(gh.requestsMatching('GET', /\/git\/blobs\//).filter(r => r.path.endsWith(blobSha('OWNERS_ALIASES')))).toHaveLength(1)
    expect(gh.requestsMatching('GET', /\/teams\/|\/members\/|\/collaborators\//)).toEqual([])
  })

  it('on a pull request, /approve expands aliases in coverage, [APPROVALNOTIFIER] and /assign suggestions, and refuses the alias name itself', async () => {
    const ownersFiles = {
      'OWNERS_ALIASES': 'aliases:\n  sdk-approvers:\n    - alice\n  olm-approvers:\n    - bob\n',
      'sdk/OWNERS': 'approvers:\n- sdk-approvers\n',
      'olm/OWNERS': 'options:\n  no_parent_owners: true\napprovers:\n- olm-approvers\n',
    }
    routeOwners(ownersFiles, ['sdk/a.go', 'olm/b.go'], { user: { login: 'some-author' } })
    gh.route('GET', `${repo}/issues/1/comments`, {
      status: 200,
      body: [{ id: 1, body: '/approve', user: { login: 'alice', type: 'User' }, created_at: '2024-01-01T00:00:01Z' }],
    })
    gh.route('GET', `${repo}/pulls/1/reviews`, { status: 200, body: [] })
    gh.route('POST', `${repo}/issues/1/comments`, { status: 201, body: {} })

    const partial = await approve(prCommentEvent('/approve', 'alice'))

    expect(partial.status, partial.stdout).toBe(0)
    expect(partial.errors).toEqual([])
    const notifier = (gh.requestsMatching('POST', /\/issues\/1\/comments$/)[0].body as { body: string }).body
    expect(notifier).toContain('This pull-request has been approved by: *alice*')
    expect(notifier).toContain('/assign @bob')
    expect(notifier).not.toContain('olm-approvers')

    // the alias name itself is replaced and cannot approve
    gh.reset()
    gh.mergeQueueFallback({ pullRequestId: 'PR_none', headOid: pullReqOpenedEvent.pull_request.head.sha, enabled: false })
    routeOwners(ownersFiles, ['sdk/a.go'], { user: { login: 'some-author' } })
    gh.route('POST', `${repo}/issues/1/comments`, { status: 201, body: {} })

    const refused = await approve(prCommentEvent('/approve', 'sdk-approvers'))

    expect(refused.status, refused.stdout).toBe(1)
    expect(refused.errors.some(e => e.includes('sdk-approvers is not an approver for any changed file'))).toBe(true)
  })

  it('on pull_request opened, blunderbuss requests expanded logins from OWNERS_ALIASES', async () => {
    routeOwners(
      {
        OWNERS_ALIASES: 'aliases:\n  sdk-reviewers:\n    - Alice\n    - carol\n',
        OWNERS: 'reviewers:\n- sdk-reviewers\n',
      },
      ['x.go'],
    )
    gh.route('POST', `${repo}/pulls/1/requested_reviewers`, { status: 201, body: {} })

    const result = await runBundle({ eventName: 'pull_request', payload: pullReqOpenedEvent, inputs: token, apiUrl: gh.url })

    expect(result.status, result.stdout).toBe(0)
    expect(result.errors).toEqual([])
    const requested = gh.requestsMatching('POST', /\/pulls\/1\/requested_reviewers$/).map(r => (r.body as { reviewers: string[] }).reviewers)
    expect(requested).toHaveLength(1)
    expect(requested[0]?.sort()).toEqual(['alice', 'carol'])
  })

  it('expands an alias that references a @org/team group and never treats @-prefixed entries as aliases', async () => {
    routeOwners(
      {
        OWNERS_ALIASES: 'aliases:\n  team-alias:\n    - "@codertocat/reviewers"\n  "@codertocat/shadow":\n    - mallory\n',
        OWNERS: 'reviewers:\n- team-alias\n- "@codertocat/shadow"\n',
      },
      ['x.go'],
      { user: { login: 'some-author' } },
    )
    gh.route('GET', '/orgs/Codertocat/teams/reviewers/members', { status: 200, body: [{ login: 'Alice' }] })
    gh.route('GET', '/orgs/Codertocat/teams/shadow/members', { status: 404, body: { message: 'Not Found' } })
    gh.route('POST', `${repo}/statuses/headsha`, { status: 201, body: {} })
    routeLabelWrite()

    const allowed = await lgtm(prCommentEvent('/lgtm', 'alice'))
    expect(allowed.status, allowed.stdout).toBe(0)
    expect(gh.requestsMatching('POST', /\/issues\/1\/labels$/).map(r => r.body)).toEqual([{ labels: ['lgtm'] }])

    gh.reset()
    gh.mergeQueueFallback({ pullRequestId: 'PR_none', headOid: pullReqOpenedEvent.pull_request.head.sha, enabled: false })
    routeOwners(
      {
        OWNERS_ALIASES: 'aliases:\n  "@codertocat/shadow":\n    - mallory\n',
        OWNERS: 'reviewers:\n- "@codertocat/shadow"\n',
      },
      ['x.go'],
      { user: { login: 'some-author' } },
    )
    gh.route('GET', '/orgs/Codertocat/teams/shadow/members', { status: 404, body: { message: 'Not Found' } })
    gh.route('POST', `${repo}/issues/1/comments`, { status: 201, body: {} })

    const denied = await lgtm(prCommentEvent('/lgtm', 'mallory'))
    expect(denied.status, denied.stdout).toBe(1)
    expect(denied.errors.some(e => e.includes('mallory is not a reviewer or approver for any changed file'))).toBe(true)
  })

  it('on an issue, authorizes via root OWNERS_ALIASES (including @org/team) and replaces colliding alias names', async () => {
    routeRootFile('OWNERS', 'reviewers:\n- triage-team\n')
    routeRootFile('OWNERS_ALIASES', 'aliases:\n  triage-team:\n    - Codertocat\n')
    routeLabelWrite()

    const viaAlias = await lgtm(comment('/lgtm', 'some-author'))

    expect(viaAlias.status, viaAlias.stdout).toBe(0)
    expect(viaAlias.errors).toEqual([])
    expect(gh.requestsMatching('POST', /\/issues\/1\/labels$/).map(r => r.body)).toEqual([{ labels: ['lgtm'] }])
    expectCommandThenConfig([rootOwnersRead, rootAliasesRead, labelsRead, labelsPost])

    // alias name colliding with a GitHub login replaces the alias name instead of admitting it
    gh.reset()
    routeRootFile('OWNERS', 'reviewers:\n- codertocat\n')
    routeRootFile('OWNERS_ALIASES', 'aliases:\n  codertocat:\n    - alice\n')
    gh.route('POST', `${repo}/issues/1/comments`, { status: 201, body: {} })

    const collision = await lgtm(comment('/lgtm', 'some-author'))
    expect(collision.status, collision.stdout).toBe(1)
    expect(collision.errors.some(e => e.includes('Codertocat is not included in the reviewers role in the OWNERS file'))).toBe(true)
    expect(gh.requestsMatching('POST', /\/issues\/1\/labels$/)).toEqual([])
    expectCommandThenConfig([rootOwnersRead, rootAliasesRead, commentPost])

    // alias expanding to @org/team on an issue
    gh.reset()
    routeRootFile('OWNERS', 'reviewers:\n- triage-team\n')
    routeRootFile('OWNERS_ALIASES', 'aliases:\n  triage-team:\n    - "@codertocat/reviewers"\n')
    gh.route('GET', '/orgs/Codertocat/teams/reviewers/members', { status: 200, body: [{ login: 'Codertocat' }] })
    routeLabelWrite()

    const viaTeam = await lgtm(comment('/lgtm', 'some-author'))
    expect(viaTeam.status, viaTeam.stdout).toBe(0)
    expect(viaTeam.errors).toEqual([])
    expect(gh.requestsMatching('POST', /\/issues\/1\/labels$/).map(r => r.body)).toEqual([{ labels: ['lgtm'] }])
    expectCommandThenConfig([rootOwnersRead, rootAliasesRead, 'GET /orgs/Codertocat/teams/reviewers/members?per_page=100', labelsRead, labelsPost])
  })

  it('under authorization.labels: trusted, admits a user listed via root OWNERS_ALIASES', async () => {
    gh.route('GET', prowYamlPath, contentsBody('labels:\n  triage:\n    values: [accepted]\nauthorization:\n  labels: trusted\n'))
    gh.route('GET', '/orgs/Codertocat/members/rita', notFound)
    gh.route('GET', `${repo}/collaborators/rita`, notFound)
    routeRootFile('OWNERS', 'reviewers:\n- triage-group\n')
    routeRootFile('OWNERS_ALIASES', 'aliases:\n  triage-group:\n    - Rita\n')
    routeLabelWrite('triage/accepted')

    const payload = comment('/triage accepted')
    payload.comment.user.login = 'rita'
    const result = await runBundle({ eventName: 'issue_comment', payload, inputs: { ...token, 'prow-commands': '/triage' }, apiUrl: gh.url })

    expect(result.status, result.stdout).toBe(0)
    expect(result.errors).toEqual([])
    expect(gh.requestsMatching('POST', /\/issues\/1\/labels$/)[0].body).toEqual({ labels: ['triage/accepted'] })
    expectRequests(configReads({ repo: '.github/prow.yaml' }), [...membershipReads('rita'), rootOwnersRead, rootAliasesRead, labelsRead, labelsPost])
  })

  it('on a truncated base tree, probes OWNERS_ALIASES (authorizing when present, failing closed on non-404)', async () => {
    gh.route('GET', `${repo}/git/trees/basesha`, { status: 200, body: { sha: 'basesha', truncated: true, tree: [] } })
    routeOwners({}, ['sdk/a.go'], { user: { login: 'some-author' } })
    gh.route('GET', `${repo}/contents/OWNERS`, contentsBody('reviewers:\n- sdk-reviewers\n'))
    gh.route('GET', `${repo}/contents/sdk%2FOWNERS`, notFound)
    gh.route('GET', `${repo}/contents/OWNERS_ALIASES`, contentsBody('aliases:\n  sdk-reviewers:\n    - alice\n'))
    gh.route('POST', `${repo}/statuses/headsha`, { status: 201, body: {} })
    routeLabelWrite()

    const ok = await lgtm(prCommentEvent('/lgtm', 'alice'))

    expect(ok.status, ok.stdout).toBe(0)
    expect(ok.errors).toEqual([])
    expect(calls()).toContain(`GET ${repo}/contents/OWNERS_ALIASES?ref=basesha`)

    gh.reset()
    gh.mergeQueueFallback({ pullRequestId: 'PR_none', headOid: pullReqOpenedEvent.pull_request.head.sha, enabled: false })
    gh.route('GET', `${repo}/git/trees/basesha`, { status: 200, body: { sha: 'basesha', truncated: true, tree: [] } })
    routeOwners({}, ['sdk/a.go'], { user: { login: 'some-author' } })
    gh.route('GET', `${repo}/contents/OWNERS`, contentsBody('reviewers:\n- sdk-reviewers\n'))
    gh.route('GET', `${repo}/contents/sdk%2FOWNERS`, notFound)
    gh.route('GET', `${repo}/contents/OWNERS_ALIASES`, { status: 500, body: { message: 'boom' } })
    gh.route('POST', `${repo}/issues/1/comments`, { status: 201, body: {} })

    const err = await lgtm(prCommentEvent('/lgtm', 'alice'))

    expect(err.status, err.stdout).toBe(1)
    expect(err.errors.some(e => e.includes('error loading OWNERS files at basesha'))).toBe(true)
    expect(gh.requestsMatching('POST', /\/issues\/1\/labels$/)).toEqual([])
  })

  it('on a truncated base tree with no OWNERS files, skips probing OWNERS_ALIASES and falls back to membership', async () => {
    gh.route('GET', `${repo}/git/trees/basesha`, { status: 200, body: { sha: 'basesha', truncated: true, tree: [] } })
    routeOwners({}, ['sdk/a.go'], { user: { login: 'some-author' } })
    gh.route('GET', `${repo}/contents/OWNERS`, notFound)
    gh.route('GET', `${repo}/contents/sdk%2FOWNERS`, notFound)
    gh.route('GET', '/orgs/Codertocat/members/alice', { status: 204 })
    gh.route('POST', `${repo}/statuses/headsha`, { status: 201, body: {} })
    routeLabelWrite()

    const result = await lgtm(prCommentEvent('/lgtm', 'alice'))

    expect(result.status, result.stdout).toBe(0)
    expect(gh.requestsMatching('GET', /\/contents\/OWNERS_ALIASES/)).toEqual([])
    expect(gh.requestsMatching('POST', /\/issues\/1\/labels$/).map(r => r.body)).toEqual([{ labels: ['lgtm'] }])
  })

  it.each([
    ['comment-only', '# OWNERS_ALIASES\n# none yet\n'],
    ['a yaml list', '- alice\n'],
    ['missing aliases key', 'other: 1\n'],
    ['null aliases key', 'aliases:\n'],
  ])('treats %s OWNERS_ALIASES as empty and refuses unlisted commenters', async (_label, contents) => {
    routeOwners({ OWNERS: 'reviewers:\n- api-reviewers\n', OWNERS_ALIASES: contents }, ['x.go'], { user: { login: 'some-author' } })
    gh.route('POST', `${repo}/issues/1/comments`, { status: 201, body: {} })

    const result = await lgtm(prCommentEvent('/lgtm', 'alice'))

    expect(result.status, result.stdout).toBe(1)
    expect(result.errors.some(e => e.includes('alice is not a reviewer or approver for any changed file'))).toBe(true)
    expect(gh.requestsMatching('POST', /\/issues\/1\/labels$/)).toEqual([])
  })

  it.each([
    ['multiple yaml documents', 'aliases:\n  api:\n  - alice\n---\naliases:\n  api:\n  - bob\n', 'YAMLException: expected a single document in the stream, but found more'],
    ['aliases is a scalar', 'aliases: alice\n', 'TypeError: OWNERS_ALIASES: aliases must be a mapping of alias names to lists of GitHub usernames'],
    ['aliases is a list', 'aliases:\n- alice\n', 'TypeError: OWNERS_ALIASES: aliases must be a mapping of alias names to lists of GitHub usernames'],
    ['an alias is a scalar', 'aliases:\n  api: alice\n', 'Error: OWNERS_ALIASES: alias api must be a list of GitHub usernames'],
    ['an alias contains a non-string', 'aliases:\n  api:\n  - alice\n  - 7\n', 'Error: OWNERS_ALIASES: alias api must be a list of GitHub usernames'],
  ])('fails closed when OWNERS_ALIASES has %s', async (_label, contents, message) => {
    routeOwners({ OWNERS: 'reviewers:\n- api\n', OWNERS_ALIASES: contents }, ['x.go'], { user: { login: 'some-author' } })
    gh.route('POST', `${repo}/issues/1/comments`, { status: 201, body: {} })

    const result = await lgtm(prCommentEvent('/lgtm', 'alice'))

    expect(result.status, result.stdout).toBe(1)
    expect(result.errors.some(e => e.includes(`error loading OWNERS files at basesha: ${message}`))).toBe(true)
    expect(gh.requestsMatching('POST', /\/issues\/1\/labels$/)).toEqual([])
  })

  it('on an issue, fails closed when root OWNERS_ALIASES fails to fetch', async () => {
    routeRootFile('OWNERS', 'reviewers:\n- triage-team\n')
    gh.route('GET', `${repo}/contents/OWNERS_ALIASES`, { status: 500, body: { message: 'boom' } })
    gh.route('POST', `${repo}/issues/1/comments`, { status: 201, body: {} })

    const result = await lgtm(comment('/lgtm', 'some-author'))

    expect(result.status, result.stdout).toBe(1)
    expect(result.errors.some(e => e.includes('error loading OWNERS files'))).toBe(true)
    expectCommandThenConfig([rootOwnersRead, rootAliasesRead, commentPost])
  })

  it('does not enable OWNERS mode when a repository has only OWNERS_ALIASES and no OWNERS files', async () => {
    routeOwners({ OWNERS_ALIASES: 'aliases:\n  maintainers:\n    - bob\n' }, ['x.go'], { user: { login: 'some-author' } })
    gh.route('GET', '/orgs/Codertocat/members/alice', { status: 204 })
    gh.route('POST', `${repo}/statuses/headsha`, { status: 201, body: {} })
    routeLabelWrite()

    const result = await lgtm(prCommentEvent('/lgtm', 'alice'))

    expect(result.status, result.stdout).toBe(0)
    expect(gh.requestsMatching('GET', /\/git\/blobs\//)).toEqual([])
    expect(calls().slice(0, ownersReads.length)).toEqual(ownersReads)
    expect(gh.requestsMatching('POST', /\/issues\/1\/labels$/).map(r => r.body)).toEqual([{ labels: ['lgtm'] }])
  })
})
