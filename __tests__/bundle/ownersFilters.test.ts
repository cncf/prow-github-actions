import type { FakeGithub } from './fakeGithub'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { prCommentEvent } from '../utils/ownersFixtures'
import { start } from './fakeGithub'
import { helpersFor, repo, token } from './helpers'
import { runBundle } from './runBundle'

vi.setConfig({ testTimeout: 30_000 })

// An OWNERS `filters` section (owners.ts parseOwners) is accepted but ignored, as
// docs/prow-for-your-org.md and docs/commands.md state: the top-level roles alone
// authorize, and the debug log notes the ignored key. Driven through dist/index.js
// with `/approve` on a pull request, like the OWNERS suites in bundle.test.ts.
describe('dist/index.js OWNERS filters are ignored', () => {
  // alice approves at the top level; bob only inside a filter, which Prow-style
  // filters would honour but this action does not
  const ownersFiles: Record<string, string> = {
    OWNERS: 'approvers:\n- alice\nfilters:\n  ".*":\n    approvers:\n    - bob\n',
  }
  const ignored = 'OWNERS at OWNERS: filters are not supported; ignoring'
  let gh: FakeGithub
  const { routeOwners } = helpersFor(() => gh)

  beforeAll(async () => {
    gh = await start()
  })
  afterEach(() => gh.reset())
  afterAll(() => gh.close())

  function routeApprove(comments: unknown[] = []) {
    routeOwners(ownersFiles, ['src/file1.txt'])
    gh.route('GET', `${repo}/issues/1/comments`, { status: 200, body: comments })
    gh.route('GET', `${repo}/pulls/1/reviews`, { status: 200, body: [] })
    gh.route('GET', `${repo}/labels`, { status: 200, body: [{ name: 'approved' }, { name: 'lgtm' }] })
    gh.route('POST', `${repo}/issues/1/labels`, { status: 200, body: [] })
    gh.route('POST', `${repo}/issues/1/comments`, { status: 201, body: {} })
  }

  function runApprove(commenter: string) {
    return runBundle({
      eventName: 'issue_comment',
      payload: prCommentEvent('/approve', commenter),
      inputs: { ...token, 'prow-commands': '/approve' },
      apiUrl: gh.url,
    })
  }

  it('a top-level approver still approves, and the ignored filters are debug-logged', async () => {
    routeApprove([{ id: 1, body: '/approve', user: { login: 'alice', type: 'User' }, created_at: '2024-01-01T00:00:01Z' }])

    const result = await runApprove('alice')

    expect(result.status, result.stdout).toBe(0)
    expect(result.errors).toEqual([])
    expect(result.stdout).toContain(ignored)
    expect(result.stdout).toContain('approve: #1 is approved by alice')
    expect(gh.requestsMatching('POST', /\/issues\/1\/labels$/).map(r => r.body)).toEqual([{ labels: ['approved'] }])
  })

  it('an approver listed only inside a filter is refused: the filter grants nothing', async () => {
    routeApprove()

    const result = await runApprove('bob')

    const wantErr = 'bob is not an approver for any changed file'
    expect(result.status, result.stdout).toBe(1)
    expect(result.stdout).toContain(ignored)
    expect(result.errors.some(e => e.includes(wantErr))).toBe(true)
    expect(gh.requestsMatching('POST', /\/issues\/1\/labels$/)).toEqual([])
    const comments = gh.requestsMatching('POST', /\/issues\/1\/comments$/)
    expect(comments).toHaveLength(1)
    expect(comments[0].body).toEqual({ body: `Cannot approve the pull request: Error: ${wantErr}` })
  })
})
