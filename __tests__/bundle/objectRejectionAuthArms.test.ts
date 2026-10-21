import type { FakeGithub } from './fakeGithub'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { start } from './fakeGithub'
import { comment, helpersFor, repo, token } from './helpers'
import { runBundle } from './runBundle'

vi.setConfig({ testTimeout: 30_000 })

const preload = path.resolve(__dirname, 'objectRejectionPreload.cjs')

// getErrorDetails (src/utils/auth.ts) folds an object rejection's fields: `'status' in error ? error.status : 'unknown'`
// and `'message' in error && typeof error.message === 'string' ? error.message : String(error)`. Octokit wraps every
// fetch rejection in a RequestError, which always carries both, so neither else-arm runs through the bundle unless a
// client call rejects with a bare object. The preload hands the bundle one Response whose `status` getter throws the
// JSON object the test names, the one read @octokit/request makes outside its try/catch. Each fold must still take
// the "unexpected error" path: warn with the folded details, deny the write, and leave no unhandled rejection.
describe('dist/index.js when a collaborator check rejects with a plain object', () => {
  let gh: FakeGithub
  const { calls } = helpersFor(() => gh)

  const collaboratorPath = `${repo}/collaborators/Codertocat`
  const target = `GET ${collaboratorPath}`

  beforeAll(async () => {
    gh = await start()
  })
  afterEach(() => gh.reset())
  afterAll(() => gh.close())

  function env(value: Record<string, unknown>) {
    return { NODE_OPTIONS: `--require "${preload}"`, OBJECT_REJECT: target, OBJECT_REJECT_VALUE: JSON.stringify(value) }
  }

  async function retitle(value: Record<string, unknown>) {
    gh.route('GET', collaboratorPath, { status: 204 })
    gh.route('PATCH', `${repo}/issues/1`, { status: 200, body: {} })

    return runBundle({
      eventName: 'issue_comment',
      payload: comment('/retitle A better title'),
      inputs: { ...token, 'prow-commands': '/retitle' },
      apiUrl: gh.url,
      env: env(value),
    })
  }

  function warnings(stdout: string) {
    return stdout.split(/\r?\n/).filter(line => line.startsWith('::warning::'))
  }

  it('a status-less object with a message (a socket error shape): status folds to "unknown", the message is kept verbatim, and the retitle is denied', async () => {
    const result = await retitle({ code: 'ECONNRESET', message: 'socket hang up' })

    expect(result.status, result.stdout).toBe(0)
    expect(result.errors).toEqual([])
    expect(warnings(result.stdout)).toEqual([
      '::warning::encountered unexpected error checking collaborator status: status=unknown, message=socket hang up',
    ])
    expect(result.stderr).not.toMatch(/Unhandled|unhandledRejection/)
    // the faulted read reached the fake and was recorded like any other; nothing was written
    expect(calls()).toEqual([target])
    expect(gh.requestsMatching('PATCH', /\/issues\/1$/)).toEqual([])
  })

  it('an object with a status but no string message: the status is kept, the message falls back to String(error), and the retitle is denied', async () => {
    const result = await retitle({ status: 502, code: 'EAI_AGAIN' })

    expect(result.status, result.stdout).toBe(0)
    expect(result.errors).toEqual([])
    expect(warnings(result.stdout)).toEqual([
      '::warning::encountered unexpected error checking collaborator status: status=502, message=[object Object]',
    ])
    expect(result.stderr).not.toMatch(/Unhandled|unhandledRejection/)
    expect(calls()).toEqual([target])
    expect(gh.requestsMatching('PATCH', /\/issues\/1$/)).toEqual([])
  })

  it('a 404 carried by a bare object is still read as "not a collaborator" and denies the retitle quietly', async () => {
    const result = await retitle({ status: 404, message: 'Not Found' })

    expect(result.status, result.stdout).toBe(0)
    expect(result.errors).toEqual([])
    expect(warnings(result.stdout)).toEqual([])
    expect(result.stderr).not.toMatch(/Unhandled|unhandledRejection/)
    expect(calls()).toEqual([target])
    expect(gh.requestsMatching('PATCH', /\/issues\/1$/)).toEqual([])
  })
})
