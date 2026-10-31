import type { FakeGithub } from './fakeGithub'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { start } from './fakeGithub'
import { comment, commentsRead, helpersFor, membershipReads, repo, token } from './helpers'
import { runBundle } from './runBundle'

vi.setConfig({ testTimeout: 30_000 })

// the /assign self-assign refusal, driven through dist/index.js: a commenter who is neither an org member nor
// a collaborator and has no earlier comment on the issue is not assigned, and the run still succeeds -
// selfAssign's false arm (src/issueComment/assign.ts:100). assignArms.test.ts covers the refused writes and
// the empty argument set
describe('dist/index.js /assign by an unauthorized commenter', () => {
  let gh: FakeGithub
  const { calls } = helpersFor(() => gh)

  beforeAll(async () => {
    gh = await start()
  })
  afterEach(() => gh.reset())
  afterAll(() => gh.close())

  it('does not assign and does not fail when the commenter is not authorized', async () => {
    gh.route('GET', `${repo}/collaborators/Codertocat`, { status: 404, body: { message: 'Not Found' } })
    gh.route('GET', `${repo}/issues/1/comments`, { status: 200, body: [] })

    const result = await runBundle({
      eventName: 'issue_comment',
      payload: comment('/assign'),
      inputs: { ...token, 'prow-commands': '/assign' },
      apiUrl: gh.url,
    })

    expect(result.status, result.stdout).toBe(0)
    expect(result.errors).toEqual([])
    expect(gh.requestsMatching('POST', /./)).toEqual([])
    expect(calls()).toEqual([...membershipReads('Codertocat'), commentsRead])
  })
})
