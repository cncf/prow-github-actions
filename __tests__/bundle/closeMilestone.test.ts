import type { FakeGithub } from './fakeGithub'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { start } from './fakeGithub'
import { comment, helpersFor, repo, token } from './helpers'
import { runBundle } from './runBundle'

vi.setConfig({ testTimeout: 30_000 })

// the /close and /milestone arms bundle.test.ts does not reach: the plain close and its
// write failure, and the milestone refusals - driven through dist/index.js
describe('dist/index.js /close and /milestone', () => {
  const collaboratorRead = `GET ${repo}/collaborators/Codertocat`
  const issuePatch = `PATCH ${repo}/issues/1`
  let gh: FakeGithub
  const { calls } = helpersFor(() => gh)

  beforeAll(async () => {
    gh = await start()
  })
  afterEach(() => gh.reset())
  afterAll(() => gh.close())

  function run(body: string, command: string, author?: string) {
    return runBundle({
      eventName: 'issue_comment',
      payload: comment(body, author),
      inputs: { ...token, 'prow-commands': command },
      apiUrl: gh.url,
    })
  }

  describe('/close', () => {
    it('by the issue author closes without a collaborator read and without a state_reason', async () => {
      gh.route('PATCH', `${repo}/issues/1`, { status: 200, body: {} })

      const result = await run('/close', '/close')

      expect(result.status, result.stdout).toBe(0)
      expect(result.errors).toEqual([])
      expect(calls()).toEqual([issuePatch])
      expect(gh.requestsMatching('PATCH', /\/issues\/1$/)[0].body).toEqual({ state: 'closed' })
    })

    it('whose issue update fails reports the write failure and fails the run', async () => {
      gh.route('PATCH', `${repo}/issues/1`, { status: 500, body: { message: 'boom' } })

      const result = await run('/close', '/close')

      expect(result.status, result.stdout).toBe(1)
      expect(result.errors.some(e => e.includes('could not close issue'))).toBe(true)
      expect(calls()).toEqual([issuePatch])
    })
  })

  describe('/milestone', () => {
    const milestonesRead = `GET ${repo}/milestones`

    it('naming a milestone that does not exist fails listing the available titles and updates nothing', async () => {
      gh.route('GET', `${repo}/collaborators/Codertocat`, { status: 204 })
      gh.route('GET', `${repo}/milestones`, { status: 200, body: [{ number: 3, title: 'v1.0' }, { number: 7, title: 'Sprint 2' }] })

      const result = await run('/milestone v9', '/milestone')

      expect(result.status, result.stdout).toBe(1)
      expect(result.errors.some(e => e.includes('milestone "v9" not found. Available milestones: v1.0, Sprint 2'))).toBe(true)
      expect(calls()).toEqual([collaboratorRead, milestonesRead])
    })

    it('with no argument fails asking for a milestone after the collaborator read', async () => {
      gh.route('GET', `${repo}/collaborators/Codertocat`, { status: 204 })

      const result = await run('/milestone', '/milestone')

      expect(result.status, result.stdout).toBe(1)
      expect(result.errors.some(e => e.includes('please provide a milestone to add'))).toBe(true)
      expect(calls()).toEqual([collaboratorRead])
    })

    it('by a non-collaborator is refused before the milestones are read', async () => {
      gh.route('GET', `${repo}/collaborators/Codertocat`, { status: 404, body: { message: 'Not Found' } })

      const result = await run('/milestone v1.0', '/milestone')

      expect(result.status, result.stdout).toBe(1)
      expect(result.errors.some(e => e.includes('commenter is not authorized to set a milestone'))).toBe(true)
      expect(calls()).toEqual([collaboratorRead])
    })
  })
})
