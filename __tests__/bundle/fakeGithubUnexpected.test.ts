import type { FakeGithub } from './fakeGithub'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { start } from './fakeGithub'
import { repo } from './helpers'

// The fake's own contract for traffic no route answers (fakeGithub.ts: `unmatched`, `allowUnmatched`,
// `unexpectedRequests`, `assertNoUnexpectedRequests`), driven with plain fetches rather than dist/index.js:
// a scenario that forgets a route must be told so by the harness, outside whatever fallback the
// application applies to the 404, and only the probes it declares intentional are left out.
describe('fakeGithub unexpected traffic', () => {
  let gh: FakeGithub

  beforeAll(async () => {
    gh = await start()
  })
  afterEach(() => gh.reset())
  afterAll(() => gh.close())

  function call(method: string, path: string): Promise<Response> {
    return fetch(`${gh.url}${path}`, { method })
  }

  it('answers an unrouted request 404 and records it as unmatched and unexpected', async () => {
    const response = await call('GET', `${repo}/pulls/1`)

    expect(response.status).toBe(404)
    expect(gh.unmatched).toEqual([{ method: 'GET', path: `${repo}/pulls/1`, body: undefined }])
    expect(gh.unexpectedRequests()).toEqual(gh.unmatched)
    expect(() => gh.assertNoUnexpectedRequests()).toThrow(
      `the fake GitHub API answered 1 request(s) no route or allowance covers:\n  GET ${repo}/pulls/1`,
    )
  })

  it('a routed request, and one a fallback answers, are neither unmatched nor unexpected', async () => {
    gh.route('GET', `${repo}/pulls/1`, { status: 200, body: {} })
    gh.mergeQueueFallback({ pullRequestId: 'PR_none', headOid: 'head', enabled: false })

    expect((await call('GET', `${repo}/pulls/1`)).status).toBe(200)
    expect((await call('POST', '/graphql')).status).toBe(200)

    expect(gh.requests).toHaveLength(2)
    expect(gh.unmatched).toEqual([])
    expect(() => gh.assertNoUnexpectedRequests()).not.toThrow()
  })

  it('the configuration loader\'s probes are unmatched but never unexpected', async () => {
    const probes = [
      '/repos/Codertocat/.project/contents/prow.yaml',
      '/repos/Codertocat/.github/contents/prow.yaml',
      `${repo}/contents/.github%2Fprow.yaml`,
      `${repo}/contents/.github%2Fprowlabels.yaml`,
      `${repo}/contents/prow.yaml`,
      `${repo}/contents/.prowlabels.yaml`,
      `${repo}/contents/.github%2Fprow.yml`,
      `${repo}/contents/.github%2Fprowlabels.yml`,
      `${repo}/contents/prow.yml`,
      `${repo}/contents/.prowlabels.yml`,
    ]
    for (const path of probes)
      expect((await call('GET', path)).status).toBe(404)

    expect(gh.unmatched).toHaveLength(probes.length)
    expect(gh.unexpectedRequests()).toEqual([])
    expect(() => gh.assertNoUnexpectedRequests()).not.toThrow()
  })

  it('an explicitly sourced configuration read is not a loader probe', async () => {
    await call('GET', '/repos/cncf/prow-config/contents/configs%2Fprow.yaml?ref=v2')

    expect(gh.unexpectedRequests().map(r => r.path)).toEqual(['/repos/cncf/prow-config/contents/configs%2Fprow.yaml?ref=v2'])
  })

  it('allowUnmatched leaves the declared requests out, by exact path or pattern, and only for the declared method', async () => {
    gh.allowUnmatched('GET', `${repo}/collaborators/stranger`)
    gh.allowUnmatched('get', /\/orgs\/Codertocat\/members\//)

    await call('GET', `${repo}/collaborators/stranger`)
    await call('GET', `${repo}/collaborators/stranger?per_page=1`)
    await call('GET', '/orgs/Codertocat/members/stranger')
    await call('POST', '/orgs/Codertocat/members/stranger')
    await call('POST', '/graphql')

    expect(gh.unmatched).toHaveLength(5)
    expect(gh.unexpectedRequests().map(r => `${r.method} ${r.path}`)).toEqual([
      'POST /orgs/Codertocat/members/stranger',
      'POST /graphql',
    ])
    expect(() => gh.assertNoUnexpectedRequests()).toThrow(
      'answered 2 request(s) no route or allowance covers:\n  POST /orgs/Codertocat/members/stranger\n  POST /graphql',
    )
  })

  it('reset clears the unmatched record and the scenario\'s allowances, keeping the loader probes allowed', async () => {
    gh.allowUnmatched('POST', '/graphql')
    await call('POST', '/graphql')
    expect(gh.unexpectedRequests()).toEqual([])

    gh.reset()

    expect(gh.unmatched).toEqual([])
    await call('POST', '/graphql')
    await call('GET', `${repo}/contents/prow.yaml`)
    expect(gh.unexpectedRequests().map(r => r.path)).toEqual(['/graphql'])
  })
})
