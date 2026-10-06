import type { FakeGithub } from './fakeGithub'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { prCommentEvent } from '../utils/ownersFixtures'
import { start } from './fakeGithub'
import { helpersFor, membershipReads, ownersProbe, ownersReads, queueRead, repo, token } from './helpers'
import { runBundle } from './runBundle'

vi.setConfig({ testTimeout: 30_000 })

// /approve on a pull request whose repository has no OWNERS files: the command falls back to org membership
// and submits or dismisses a GitHub review from the bot. These are the arms where GitHub refuses one of
// those calls, or where there is no review left to cancel (src/issueComment/approve.ts).
describe('dist/index.js /approve membership-mode failure arms', () => {
  let gh: FakeGithub
  const { expectCommandThenConfig, routeOwners } = helpersFor(() => gh)
  const bot = { login: 'github-actions[bot]', type: 'Bot' }
  const boom = { status: 500, body: { message: 'boom' } }
  const reviewsRead = `GET ${repo}/pulls/1/reviews`
  const authReads = [...ownersReads, ...membershipReads('bob')]

  beforeAll(async () => {
    gh = await start()
  })
  afterEach(() => gh.reset())
  afterAll(() => gh.close())

  function routeMember(login = 'bob') {
    routeOwners({}, ['src/file1.txt'])
    gh.route('GET', `/orgs/Codertocat/members/${login}`, { status: 204 })
  }

  function runApprove(body: string, commenter = 'bob') {
    return runBundle({
      eventName: 'issue_comment',
      payload: prCommentEvent(body, commenter),
      inputs: { ...token, 'prow-commands': '/approve' },
      apiUrl: gh.url,
    })
  }

  // the post-command sweep still runs after the failure: it reads the configuration, the pr, probes its base for OWNERS
  // files and asks about the merge queue, then skips the unlabelled pr
  const sweep = [`GET ${repo}/pulls/1`, ownersProbe, queueRead]

  function expectAuthThen(command: string[], reads = authReads) {
    expectCommandThenConfig(command, sweep, reads)
  }

  it('/approve fails the run when the APPROVE review is refused', async () => {
    routeMember()
    gh.route('POST', `${repo}/pulls/1/reviews`, boom)

    const result = await runApprove('/approve')

    expect(result.status, result.stdout).toBe(1)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toContain('error handling issue comment: Error: could not create review')
    expect(gh.requestsMatching('POST', /\/pulls\/1\/reviews$/)[0].body).toEqual({ event: 'APPROVE', comments: [] })
    expect(gh.requestsMatching('POST', /\/issues\/1\/comments$/)).toEqual([])
    expectAuthThen([`POST ${repo}/pulls/1/reviews`])
  })

  it('/approve cancel fails the run when the reviews cannot be listed', async () => {
    routeMember()
    gh.route('GET', `${repo}/pulls/1/reviews`, boom)

    const result = await runApprove('/approve cancel')

    expect(result.status, result.stdout).toBe(1)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toContain('could not remove latest review: Error: could not list reviews for PR 1')
    expect(gh.requestsMatching('PUT', /\/dismissals$/)).toEqual([])
    expectAuthThen([reviewsRead])
  })

  it('/approve cancel fails the run when the bot has no APPROVED review to dismiss', async () => {
    routeMember()
    gh.route('GET', `${repo}/pulls/1/reviews`, {
      status: 200,
      body: [
        { id: 10, user: { login: 'carol', type: 'User' }, state: 'APPROVED' },
        { id: 11, user: bot, state: 'DISMISSED' },
        { id: 12, user: bot, state: 'COMMENTED' },
      ],
    })

    const result = await runApprove('/approve cancel')

    expect(result.status, result.stdout).toBe(1)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toContain('could not remove latest review: Error: no latest review found to cancel')
    expect(gh.requestsMatching('PUT', /\/dismissals$/)).toEqual([])
    expectAuthThen([reviewsRead])
  })

  it('/approve cancel fails the run when the dismissal is refused', async () => {
    routeMember()
    gh.route('GET', `${repo}/pulls/1/reviews`, { status: 200, body: [{ id: 12, user: bot, state: 'APPROVED' }] })
    gh.route('PUT', `${repo}/pulls/1/reviews/12/dismissals`, boom)

    const result = await runApprove('/approve cancel')

    expect(result.status, result.stdout).toBe(1)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toContain('could not remove latest review: Error: could not dismiss review')
    expect(gh.requestsMatching('PUT', /\/dismissals$/)[0].body).toEqual({ message: 'Canceled through prow-github-actions by @bob' })
    expectAuthThen([reviewsRead, `PUT ${repo}/pulls/1/reviews/12/dismissals`])
  })

  it('/approve by a stranger is refused, and a failed refusal comment is logged without masking the refusal', async () => {
    routeOwners({}, ['src/file1.txt'])
    gh.route('GET', '/orgs/Codertocat/members/stranger', { status: 404, body: { message: 'Not Found' } })
    gh.route('GET', `${repo}/collaborators/stranger`, { status: 404, body: { message: 'Not Found' } })
    gh.route('POST', `${repo}/issues/1/comments`, boom)

    const result = await runApprove('/approve', 'stranger')

    expect(result.status, result.stdout).toBe(1)
    expect(result.errors).toEqual([
      'Cannot approve the pull request: Error: stranger is not a org member or collaborator',
      'Could not comment with an auth error: Error: could not add comment: HttpError: boom',
      'TypeError: error handling issue comment: Error: stranger is not a org member or collaborator',
    ])
    expect(gh.requestsMatching('POST', /\/pulls\/1\/reviews$/)).toEqual([])
    expectAuthThen([`POST ${repo}/issues/1/comments`], [...ownersReads, ...membershipReads('stranger')])
  })
})
