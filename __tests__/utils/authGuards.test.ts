import { Buffer } from 'node:buffer'

import * as core from '@actions/core'
import { Octokit } from '@octokit/rest'
import { http } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  assertAuthorizedByOwnersOrMembership,
  checkIssueComments,
  checkOrgMember,
  policyAllows,
} from '../../src/utils/auth'
import issueCommentEvent from '../fixtures/issues/issueCommentEvent.json'

import * as utils from '../testUtils'

// Guards of src/utils/auth.ts that the rest of the suite reaches but never
// distinguishes from their mutation: each case here fails when the guarded
// expression is replaced by a constant or its operator is flipped, or when a
// memoization key loses the repository or issue that scopes it.

const server = setupServer()
beforeAll(() => {
  utils.setupActionsEnv()
  server.listen(utils.failOnUnhandledRequest)
})
beforeEach(() => vi.clearAllMocks())
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

const octokit = new Octokit({ auth: 'some-token' })
const context = new utils.MockContext(issueCommentEvent)
const repo = `${utils.api}/repos/Codertocat/Hello-World`

function rootOwners(body: Record<string, unknown>) {
  return http.get(`${repo}/contents/OWNERS`, utils.mockResponse(200, { type: 'file', size: 4096, name: 'OWNERS', path: 'OWNERS', ...body }))
}

function membership(login: string) {
  return [
    http.get(`${utils.api}/orgs/Codertocat/members/${login}`, utils.mockResponse(404)),
    http.get(`${repo}/collaborators/${login}`, utils.mockResponse(404)),
  ]
}

describe('checkOrgMember', () => {
  it('refuses a payload without a repository quietly, without a warning annotation', async () => {
    const noRepository = new utils.MockContext(issueCommentEvent)
    delete noRepository.payload.repository

    await expect(checkOrgMember(octokit, noRepository, 'some-user')).resolves.toBe(false)
    expect(core.warning).not.toHaveBeenCalled()
    expect(core.debug).toHaveBeenCalledWith('checkOrgMember error: context payload repository undefined')
  })

  it('refuses with a warning when the membership check rejects with null, instead of throwing on the guard', async () => {
    // `typeof null` is 'object'; without the null check the error-detail read throws a TypeError
    // inside the catch block and the rejection escapes the membership check
    vi.spyOn(octokit.orgs, 'checkMembershipForUser').mockRejectedValueOnce(null)

    await expect(checkOrgMember(octokit, context, 'some-user')).resolves.toBe(false)
    expect(core.warning).toHaveBeenCalledWith('encountered unexpected error: status=unknown, message=null')
  })

  it('renders a rejection whose message is not a string as the object, not as the message', async () => {
    vi.spyOn(octokit.orgs, 'checkMembershipForUser').mockRejectedValueOnce({ status: 500, message: 42 })

    await expect(checkOrgMember(octokit, context, 'some-user')).resolves.toBe(false)
    expect(core.warning).toHaveBeenCalledWith('encountered unexpected error: status=500, message=[object Object]')
  })
})

describe('checkIssueComments', () => {
  it('memoizes per issue: a second issue in the repository is not answered from the first', async () => {
    server.use(
      http.get(`${repo}/issues/1/comments`, utils.mockResponse(200, [{ id: 1, user: { login: 'some-user' }, body: 'here' }])),
      http.get(`${repo}/issues/2/comments`, utils.mockResponse(200, [])),
    )

    await expect(checkIssueComments(octokit, context, 1, 'some-user')).resolves.toBe(true)
    await expect(checkIssueComments(octokit, context, 2, 'some-user')).resolves.toBe(false)
  })

  it('skips a comment whose user is gone and keeps scanning', async () => {
    server.use(
      http.get(`${repo}/issues/1/comments`, utils.mockResponse(200, [
        { id: 1, user: null, body: 'from a deleted account' },
        { id: 2, user: { login: 'some-user' }, body: 'still here' },
      ])),
    )

    await expect(checkIssueComments(octokit, context, 1, 'some-user')).resolves.toBe(true)
    expect(core.warning).not.toHaveBeenCalled()
  })
})

describe('the root OWNERS read', () => {
  it.each([
    ['a string', 'socket hang up', 'socket hang up'],
    ['null', null, 'null'],
  ])('reports %s rejection of the contents read as an OWNERS lookup error', async (_, rejection, text) => {
    vi.spyOn(octokit.repos, 'getContent').mockRejectedValueOnce(rejection)

    await expect(assertAuthorizedByOwnersOrMembership(octokit, context, 'reviewers', 'Alice'))
      .rejects
      .toThrow(`error checking for an OWNERS file at the root of the repository: ${text}`)
  })

  it('rejects a contents response that carries content but no encoding instead of decoding it', async () => {
    server.use(rootOwners({ content: Buffer.from('reviewers:\n  - alice\n').toString('base64') }))

    await expect(assertAuthorizedByOwnersOrMembership(octokit, context, 'reviewers', 'Alice'))
      .rejects
      .toThrow('invalid OWNERS file returned from GitHub API')
  })

  it('rejects a contents response that carries an encoding but no content', async () => {
    server.use(rootOwners({ encoding: 'base64' }))

    await expect(assertAuthorizedByOwnersOrMembership(octokit, context, 'reviewers', 'Alice'))
      .rejects
      .toThrow('invalid OWNERS file returned from GitHub API')
  })

  it('names the root OWNERS file when a role is not a list', async () => {
    server.use(rootOwners({ encoding: 'base64', content: Buffer.from('approvers: alice\n').toString('base64') }))

    await expect(assertAuthorizedByOwnersOrMembership(octokit, context, 'reviewers', 'Alice'))
      .rejects
      .toThrow('OWNERS at OWNERS: approvers must be a list of GitHub usernames')
  })

  it('names the root OWNERS file when the trusted policy falls through to a malformed file', async () => {
    server.use(
      ...membership('Alice'),
      rootOwners({ encoding: 'base64', content: Buffer.from('reviewers: alice\n').toString('base64') }),
    )

    await expect(policyAllows(octokit, context, 'trusted', 'Alice', []))
      .rejects
      .toThrow('OWNERS at OWNERS: reviewers must be a list of GitHub usernames')
  })

  it('memoizes per repository: a second repository without a root OWNERS file is not answered from the first', async () => {
    // the App server and a cron run authorize across repositories within one state; a key
    // without the repository would let Hello-World's reviewers pass the trusted policy on Other
    const other = `${utils.api}/repos/Codertocat/Other`
    server.use(
      ...membership('Alice'),
      rootOwners({ encoding: 'base64', content: Buffer.from('reviewers:\n  - alice\n').toString('base64') }),
      http.get(`${other}/collaborators/Alice`, utils.mockResponse(404)),
      http.get(`${other}/contents/OWNERS`, utils.mockResponse(404)),
    )
    const otherContext = new utils.MockContext({ repository: { owner: { login: 'Codertocat' }, name: 'Other' } })

    await expect(policyAllows(octokit, context, 'trusted', 'Alice', [])).resolves.toBe(true)
    await expect(policyAllows(octokit, otherContext, 'trusted', 'Alice', [])).resolves.toBe(false)
  })
})
