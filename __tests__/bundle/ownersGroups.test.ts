import type { FakeGithub } from './fakeGithub'
import { Buffer } from 'node:buffer'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import pullReqOpenedEvent from '../fixtures/pullReq/pullReqOpenedEvent.json'
import { prCommentEvent } from '../utils/ownersData'
import { start } from './fakeGithub'
import { comment, helpersFor, repo, token } from './helpers'
import { runBundle } from './runBundle'

vi.setConfig({ testTimeout: 30_000 })

// `@org/team` entries of OWNERS files (src/utils/owners.ts: expandGroups, ownersInclude), driven through
// dist/index.js: the team is read once per run however many files and roles list it, a login listed
// directly never reads a team, and a group of another org or an unreadable team warns once and admits nobody
describe('dist/index.js OWNERS groups', () => {
  const teamRead = `GET /orgs/Codertocat/teams/reviewers/members?per_page=100`
  const rootOwnersRead = `GET ${repo}/contents/OWNERS`
  const labelsRead = `GET ${repo}/labels?per_page=100`
  const labelsPost = `POST ${repo}/issues/1/labels`
  const commentPost = `POST ${repo}/issues/1/comments`
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

  function routeTeam(members: string[]) {
    gh.route('GET', '/orgs/Codertocat/teams/reviewers/members', { status: 200, body: members.map(login => ({ login })) })
  }

  function routePaginatedTeam(firstPage: string[], secondPage: string[]) {
    gh.route('GET', /^\/orgs\/Codertocat\/teams\/reviewers\/members/, (req) => {
      const page = new URL(req.path, 'http://localhost').searchParams.get('page')
      return page === '2'
        ? { status: 200, body: secondPage.map(login => ({ login })) }
        : {
            status: 200,
            body: firstPage.map(login => ({ login })),
            headers: { link: `<${gh.url}/orgs/Codertocat/teams/reviewers/members?per_page=100&page=2>; rel="next"` },
          }
    })
  }

  function routeLabelWrite() {
    gh.route('GET', `${repo}/labels`, { status: 200, body: [{ name: 'lgtm' }] })
    gh.route('POST', `${repo}/issues/1/labels`, { status: 200, body: [] })
  }

  function lgtm(payload: Record<string, unknown>) {
    return runBundle({ eventName: 'issue_comment', payload, inputs: { ...token, 'prow-commands': '/lgtm' }, apiUrl: gh.url })
  }

  function approve(payload: Record<string, unknown>) {
    return runBundle({ eventName: 'issue_comment', payload, inputs: { ...token, 'prow-commands': '/approve' }, apiUrl: gh.url })
  }

  function warnings(stdout: string) {
    return stdout.split('\n').filter(line => line.startsWith('::warning::'))
  }

  it('on a pull request, a reviewer listed only through a team is authorized; the team is read once, other-org and malformed entries warn once', async () => {
    routeOwners(
      {
        'OWNERS': 'approvers:\n- \'@bob\'\nreviewers:\n- \'@other/team\'\n',
        'sdk/OWNERS': 'reviewers:\n- \'@codertocat/reviewers\'\n',
      },
      ['sdk/a.go', 'sdk/b.go'],
      { user: { login: 'some-author' } },
    )
    routeTeam(['Alice', 'carol'])
    gh.route('POST', `${repo}/statuses/headsha`, { status: 201, body: {} })
    routeLabelWrite()

    const result = await lgtm(prCommentEvent('/lgtm', 'alice'))

    expect(result.status, result.stdout).toBe(0)
    expect(result.errors).toEqual([])
    expect(gh.requestsMatching('POST', /\/issues\/1\/labels$/).map(r => r.body)).toEqual([{ labels: ['lgtm'] }])
    expect(gh.requestsMatching('GET', /\/orgs\/Codertocat\/members\/|\/collaborators\//)).toEqual([])
    expect(calls().filter(c => c === teamRead)).toHaveLength(1)
    expect(warnings(result.stdout)).toEqual([
      '::warning::OWNERS: ignoring @bob: a group is written @<org>/<team-slug>',
      '::warning::OWNERS: ignoring group @other/team: only groups of codertocat are supported',
    ])
  })

  it('on an issue, a commenter listed through a team in the root OWNERS file is authorized by the team read', async () => {
    routeRootOwners('reviewers:\n- \'@codertocat/reviewers\'\n')
    routeTeam(['codertocat'])
    routeLabelWrite()

    const result = await lgtm(comment('/lgtm', 'some-author'))

    expect(result.status, result.stdout).toBe(0)
    expect(result.errors).toEqual([])
    expect(gh.requestsMatching('POST', /\/issues\/1\/labels$/).map(r => r.body)).toEqual([{ labels: ['lgtm'] }])
    expectCommandThenConfig([rootOwnersRead, teamRead, labelsRead, labelsPost])
  })

  it('on an issue, a commenter listed directly next to a team is authorized without reading the team', async () => {
    routeRootOwners('reviewers:\n- codertocat\n- \'@codertocat/reviewers\'\n')
    routeLabelWrite()

    const result = await lgtm(comment('/lgtm', 'some-author'))

    expect(result.status, result.stdout).toBe(0)
    expect(result.errors).toEqual([])
    expect(gh.requestsMatching('GET', /\/teams\//)).toEqual([])
    expectCommandThenConfig([rootOwnersRead, labelsRead, labelsPost])
  })

  it('a member present only on the second team page can approve a pull request', async () => {
    routeOwners(
      { OWNERS: 'approvers:\n- \'@codertocat/reviewers\'\n' },
      ['x.go'],
      { user: { login: 'some-author' } },
    )
    routePaginatedTeam(['carol'], ['alice'])
    gh.route('GET', `${repo}/issues/1/comments`, {
      status: 200,
      body: [{ id: 1, body: '/approve', user: { login: 'alice', type: 'User' }, created_at: new Date().toISOString() }],
    })
    gh.route('GET', `${repo}/pulls/1/reviews`, { status: 200, body: [] })
    gh.route('GET', `${repo}/labels`, { status: 200, body: [{ name: 'approved' }] })
    gh.route('POST', `${repo}/issues/1/labels`, { status: 200, body: [] })
    gh.route('POST', `${repo}/issues/1/comments`, { status: 201, body: {} })

    const result = await approve(prCommentEvent('/approve', 'alice'))

    expect(result.status, result.stdout).toBe(0)
    expect(result.errors).toEqual([])
    expect(result.stdout).toContain('approve: #1 is approved by alice')
    expect(gh.requestsMatching('GET', /^\/orgs\/Codertocat\/teams\/reviewers\/members/)).toHaveLength(2)
    expect(gh.requestsMatching('POST', /\/issues\/1\/labels$/).map(r => r.body)).toEqual([{ labels: ['approved'] }])
    expect(gh.requestsMatching('POST', /\/pulls\/1\/reviews$/)).toEqual([])
  })

  it('a member present only on the second team page is selected as a reviewer', async () => {
    routeOwners(
      { OWNERS: 'reviewers:\n- \'@codertocat/reviewers\'\n' },
      ['x.go'],
    )
    routePaginatedTeam(['carol'], ['alice'])
    gh.route('POST', `${repo}/pulls/1/requested_reviewers`, { status: 201, body: {} })

    const result = await runBundle({ eventName: 'pull_request', payload: pullReqOpenedEvent, inputs: token, apiUrl: gh.url })

    expect(result.status, result.stdout).toBe(0)
    expect(result.errors).toEqual([])
    expect(gh.requestsMatching('GET', /^\/orgs\/Codertocat\/teams\/reviewers\/members/)).toHaveLength(2)
    const requested = gh.requestsMatching('POST', /\/pulls\/1\/requested_reviewers$/).map(r => (r.body as { reviewers: string[] }).reviewers)
    expect(requested).toHaveLength(1)
    expect(requested[0]?.sort()).toEqual(['alice', 'carol'])
  })

  it('a team the token cannot read admits nobody: refused with one warning', async () => {
    routeRootOwners('reviewers:\n- \'@codertocat/reviewers\'\n')
    gh.route('GET', '/orgs/Codertocat/teams/reviewers/members', { status: 403, body: { message: 'Resource not accessible by integration' } })
    gh.route('POST', `${repo}/issues/1/comments`, { status: 201, body: {} })

    const result = await lgtm(comment('/lgtm', 'some-author'))

    expect(result.status, result.stdout).toBe(1)
    expect(result.errors.some(e => e.includes('Codertocat is not included in the reviewers role in the OWNERS file'))).toBe(true)
    expect(gh.requestsMatching('POST', /\/issues\/1\/labels$/)).toEqual([])
    expect(warnings(result.stdout)).toHaveLength(1)
    expect(warnings(result.stdout)[0]).toMatch(/^::warning::OWNERS: could not read the members of @codertocat\/reviewers: /)
    expectCommandThenConfig([rootOwnersRead, teamRead, commentPost])
  })
})
