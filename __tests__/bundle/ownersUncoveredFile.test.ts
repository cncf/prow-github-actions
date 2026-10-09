import type { FakeGithub } from './fakeGithub'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { prCommentEvent, pullBody } from '../utils/ownersFixtures'
import { start } from './fakeGithub'
import { helpersFor, repo, token } from './helpers'
import { runBundle } from './runBundle'

vi.setConfig({ testTimeout: 30_000 })

// the fail-closed arm of the pull-request OWNERS authorization (src/utils/auth.ts assertPullRequestOwner), driven
// through dist/index.js: the base branch has OWNERS files, so the membership fallback is off, but one changed
// file sits outside every OWNERS directory and no file covers it. `/lgtm` from an approver of the covered file
// is refused by naming the uncovered file, with no root-OWNERS read and no membership probe.
describe('dist/index.js /lgtm on a pull request that changes a file no OWNERS file covers', () => {
  let gh: FakeGithub
  const { routeOwners } = helpersFor(() => gh)

  beforeAll(async () => {
    gh = await start()
  })
  beforeEach(() => gh.mergeQueueFallback({ pullRequestId: 'PR_none', headOid: pullBody.head.sha, enabled: false }))
  afterEach(() => gh.reset())
  afterAll(() => gh.close())

  function comments() {
    return gh.requestsMatching('POST', /\/issues\/1\/comments$/).map(r => (r.body as { body: string }).body)
  }

  it('refuses the commenter by naming the uncovered file, even though they approve the covered one', async () => {
    routeOwners({ 'sdk/OWNERS': 'approvers:\n- bob\n' }, ['sdk/x.go', 'README.md'])
    gh.route('POST', `${repo}/issues/1/comments`, { status: 201, body: {} })

    const result = await runBundle({
      eventName: 'issue_comment',
      payload: prCommentEvent('/lgtm', 'bob'),
      inputs: { ...token, 'prow-commands': '/lgtm' },
      apiUrl: gh.url,
    })

    expect(result.status, result.stdout).toBe(1)
    expect(result.errors.some(e => e.includes('no OWNERS file covers README.md'))).toBe(true)
    expect(comments().some(c => c.includes('no OWNERS file covers README.md'))).toBe(true)
    expect(gh.requestsMatching('POST', /\/issues\/1\/labels$/)).toEqual([])
    // the tree had OWNERS files, so neither the root OWNERS fallback nor the membership fallback runs
    expect(gh.requestsMatching('GET', /\/contents\/OWNERS$/)).toEqual([])
    expect(gh.requestsMatching('GET', /\/orgs\/|\/collaborators\//)).toEqual([])
  })
})
