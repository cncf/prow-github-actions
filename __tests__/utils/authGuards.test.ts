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
// expression is replaced by a constant or its operator is flipped.

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
})

describe('checkIssueComments', () => {
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
})
