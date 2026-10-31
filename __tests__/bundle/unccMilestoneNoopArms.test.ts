import type { FakeGithub } from './fakeGithub'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { start } from './fakeGithub'
import { comment, helpersFor, repo, token } from './helpers'
import { runBundle } from './runBundle'

vi.setConfig({ testTimeout: 30_000 })

// the two quiet arms collaborationCommands.test.ts and closeMilestone.test.ts do not reach:
// a bare /uncc by a non-collaborator (removeSelfReviewReq's false arm, uncc.ts:79) and a
// /milestone on a repository with no milestones (the 'none' listing, milestone.ts:70) -
// driven through dist/index.js
describe('dist/index.js /uncc and /milestone quiet arms', () => {
  const collaboratorRead = `GET ${repo}/collaborators/Codertocat`
  let gh: FakeGithub
  const { calls } = helpersFor(() => gh)

  beforeAll(async () => {
    gh = await start()
  })
  afterEach(() => gh.reset())
  afterAll(() => gh.close())

  function run(body: string, command: string) {
    return runBundle({
      eventName: 'issue_comment',
      payload: comment(body),
      inputs: { ...token, 'prow-commands': command },
      apiUrl: gh.url,
    })
  }

  it('/uncc with no arguments by a non-collaborator removes no review request and succeeds', async () => {
    gh.route('GET', `${repo}/collaborators/Codertocat`, { status: 404, body: { message: 'Not Found' } })

    const result = await run('/uncc', '/uncc')

    expect(result.status, result.stdout).toBe(0)
    expect(result.errors).toEqual([])
    expect(calls()).toEqual([collaboratorRead])
    expect(gh.requestsMatching('DELETE', /./)).toEqual([])
  })

  it('/milestone on a repository without milestones fails listing "none" and updates nothing', async () => {
    gh.route('GET', `${repo}/collaborators/Codertocat`, { status: 204 })
    gh.route('GET', `${repo}/milestones`, { status: 200, body: [] })

    const result = await run('/milestone v1.0', '/milestone')

    expect(result.status, result.stdout).toBe(1)
    expect(result.errors.some(e => e.includes('milestone "v1.0" not found. Available milestones: none'))).toBe(true)
    expect(calls()).toEqual([collaboratorRead, `GET ${repo}/milestones?state=open&per_page=100`])
    expect(gh.requestsMatching('PATCH', /./)).toEqual([])
  })
})
