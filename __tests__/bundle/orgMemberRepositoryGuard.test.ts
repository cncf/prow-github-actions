import type { FakeGithub } from './fakeGithub'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { start } from './fakeGithub'
import { comment, helpersFor, repo, token } from './helpers'
import { runBundle } from './runBundle'

vi.setConfig({ testTimeout: 30_000 })

// checkOrgMember reads the org to probe from `payload.repository.owner.login`, and answers "not a member"
// without a request when the payload carries no `repository` (auth.ts:43-45). The fixtures always carry it,
// so the guard is driven here, through dist/index.js, by deleting the object: the other probes keep working
// because `context.repo` falls back to GITHUB_REPOSITORY, which runBundle always sets
describe('dist/index.js checkOrgMember without payload.repository', () => {
  let gh: FakeGithub
  const { calls } = helpersFor(() => gh)

  beforeAll(async () => {
    gh = await start()
  })
  afterEach(() => gh.reset())
  afterAll(() => gh.close())

  function run(body: string) {
    const payload = comment(body) as { repository?: Record<string, unknown> }
    delete payload.repository
    return runBundle({
      eventName: 'issue_comment',
      payload,
      inputs: { ...token, 'prow-commands': '/assign' },
      apiUrl: gh.url,
    })
  }

  it('skips the org membership read and still assigns a collaborator', async () => {
    gh.route('GET', `${repo}/collaborators/octocat`, { status: 204 })
    gh.route('GET', `${repo}/issues/1/comments`, { status: 200, body: [] })
    gh.route('POST', `${repo}/issues/1/assignees`, { status: 201, body: {} })

    const result = await run('/assign @octocat')

    expect(result.status, result.stdout).toBe(0)
    expect(result.errors).toEqual([])
    expect(result.stdout).toContain('checkOrgMember error: context payload repository undefined')
    expect(gh.requestsMatching('GET', /^\/orgs\//)).toEqual([])
    expect(calls()).toEqual([
      `GET ${repo}/collaborators/octocat`,
      `GET ${repo}/issues/1/comments`,
      `POST ${repo}/issues/1/assignees`,
    ])
    expect(gh.requestsMatching('POST', /assignees$/)[0].body).toEqual({ assignees: ['octocat'] })
  })

  it('fails naming no authorized users when the user is neither collaborator nor commenter', async () => {
    gh.route('GET', `${repo}/issues/1/comments`, { status: 200, body: [] })

    const result = await run('/assign @stranger')

    expect(result.status, result.stdout).toBe(1)
    expect(result.errors.some(e => e.includes('no authorized users found'))).toBe(true)
    expect(result.stdout).toContain('checkOrgMember error: context payload repository undefined')
    expect(gh.requestsMatching('GET', /^\/orgs\//)).toEqual([])
    expect(gh.requestsMatching('POST', /./)).toEqual([])
    expect(calls()).toEqual([`GET ${repo}/collaborators/stranger`, `GET ${repo}/issues/1/comments`])
  })
})
