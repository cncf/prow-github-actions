import type { FakeGithub } from './fakeGithub'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { start } from './fakeGithub'
import { comment, configReads, helpersFor, repo, token } from './helpers'
import { runBundle } from './runBundle'

vi.setConfig({ testTimeout: 30_000 })

// the arms of /reopen and /retitle that collaborationCommands.test.ts leaves out, driven through dist/index.js:
// a collaborator read that fails with something other than 404 is a warning and a silent no-op (checkCollaborator
// swallows it), and a refused write fails the run with the command's own cause
describe('dist/index.js /reopen and /retitle failure arms', () => {
  const collaboratorPath = `${repo}/collaborators/Codertocat`
  const issuePath = `${repo}/issues/1`
  const collaboratorRead = `GET ${collaboratorPath}`
  const issueWrite = `PATCH ${issuePath}`
  const collaboratorWarning = '::warning::encountered unexpected error checking collaborator status: status=500'
  let gh: FakeGithub
  const { calls } = helpersFor(() => gh)

  beforeAll(async () => {
    gh = await start()
  })
  afterEach(() => gh.reset())
  afterAll(() => gh.close())

  async function run(body: string, command: string, author?: string) {
    return runBundle({
      eventName: 'issue_comment',
      payload: comment(body, author),
      inputs: { ...token, 'prow-commands': command },
      apiUrl: gh.url,
    })
  }

  describe('/reopen', () => {
    it('by a non-author whose collaborator read returns 500 warns and reopens nothing', async () => {
      gh.route('GET', collaboratorPath, { status: 500, body: { message: 'boom' } })

      const result = await run('/reopen', '/reopen', 'some-author')

      expect(result.status, result.stdout).toBe(0)
      expect(result.errors).toEqual([])
      expect(result.stdout).toContain(collaboratorWarning)
      expect(calls().slice(0, 1)).toEqual([collaboratorRead])
      expect(calls().slice(1).sort()).toEqual(configReads().sort())
    })

    it('by the author fails the action when the reopen write is refused', async () => {
      gh.route('PATCH', issuePath, { status: 500, body: { message: 'boom' } })

      const result = await run('/reopen', '/reopen')

      expect(result.status, result.stdout).toBe(1)
      expect(result.errors.some(e => e.includes('could not open issue'))).toBe(true)
      expect(calls()).toEqual([issueWrite])
      expect(gh.requestsMatching('PATCH', /\/issues\/1$/)[0].body).toEqual({ state: 'open' })
    })
  })

  describe('/retitle', () => {
    it('by a collaborator fails the action when the title write is refused', async () => {
      gh.route('GET', collaboratorPath, { status: 204 })
      gh.route('PATCH', issuePath, { status: 500, body: { message: 'boom' } })

      const result = await run('/retitle A better title', '/retitle')

      expect(result.status, result.stdout).toBe(1)
      expect(result.errors.some(e => e.includes('could not update issue'))).toBe(true)
      expect(calls()).toEqual([collaboratorRead, issueWrite])
      expect(gh.requestsMatching('PATCH', /\/issues\/1$/)[0].body).toEqual({ title: 'A better title' })
    })
  })
})
