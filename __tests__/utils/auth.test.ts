import { Buffer } from 'node:buffer'

import { Octokit } from '@octokit/rest'
import { http } from 'msw'
import { setupServer } from 'msw/node'
import * as core from '@actions/core'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import {
  assertAuthorizedByOwnersOrMembership,
  checkCollaborator,
  checkCommenterAuth,
  checkIssueComments,
  checkOrgMember,
  getOrgCollabCommentUsers,
} from '../../src/utils/auth'
import issueListComments from '../fixtures/issues/assign/issueListComments.json'
import issueCommentEvent from '../fixtures/issues/issueCommentEvent.json'

import * as utils from '../testUtils'

const server = setupServer()
beforeAll(() => {
  utils.setupActionsEnv()
  server.listen({
    onUnhandledRequest: 'error',
  })
})
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

const octokit = new Octokit({ auth: 'some-token' })
const context = new utils.MockContext(issueCommentEvent)

function ownersResponse(owners: string) {
  return {
    type: 'file',
    encoding: 'base64',
    size: 4096,
    name: 'OWNERS',
    path: 'OWNERS',
    content: Buffer.from(owners).toString('base64'),
  }
}

describe('checkOrgMember', () => {
  it('is true when the org membership check returns 204', async () => {
    server.use(
      http.get(
        `${utils.api}/orgs/Codertocat/members/some-user`,
        utils.mockResponse(204),
      ),
    )

    await expect(checkOrgMember(octokit, context, 'some-user')).resolves.toBe(true)
  })

  it.each([404, 302])('does not warn when org membership check returns %i', async (status) => {
    const warningSpy = vi.spyOn(core, 'warning')

    vi.spyOn(octokit.orgs, 'checkMembershipForUser').mockRejectedValueOnce({
      status,
      message: 'Not a member',
    })

    await expect(checkOrgMember(octokit, context, 'some-user')).resolves.toBe(false)
    expect(warningSpy).not.toHaveBeenCalled()
  })

  it('warns when org membership check returns an unexpected error', async () => {
    const warningSpy = vi.spyOn(core, 'warning')

    vi.spyOn(octokit.orgs, 'checkMembershipForUser').mockRejectedValueOnce({
      status: 500,
      message: 'Internal Server Error',
    })

    await expect(checkOrgMember(octokit, context, 'some-user')).resolves.toBe(false)

    expect(warningSpy).toHaveBeenCalledWith(
      expect.stringContaining('status=500'),
    )
    expect(warningSpy).toHaveBeenCalledWith(
      expect.stringContaining('message=Internal Server Error'),
    )
  })

  it('is false when the payload has no repository', async () => {
    const noRepo = new utils.MockContext({})

    await expect(checkOrgMember(octokit, noRepo, 'some-user')).resolves.toBe(false)
  })
})

describe('checkCollaborator', () => {
  it('is true when the collaborator check returns 204', async () => {
    server.use(
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/collaborators/some-user`,
        utils.mockResponse(204),
      ),
    )

    await expect(checkCollaborator(octokit, context, 'some-user')).resolves.toBe(true)
  })

  it('does not warn when collaborator check returns 404', async () => {
    const warningSpy = vi.spyOn(core, 'warning')

    server.use(
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/collaborators/some-user`,
        utils.mockResponse(404),
      ),
    )

    await expect(checkCollaborator(octokit, context, 'some-user')).resolves.toBe(false)
    expect(warningSpy).not.toHaveBeenCalled()
  })

  it('warns when collaborator check returns an unexpected error', async () => {
    const warningSpy = vi.spyOn(core, 'warning')

    server.use(
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/collaborators/some-user`,
        utils.mockResponse(500),
      ),
    )

    await expect(checkCollaborator(octokit, context, 'some-user')).resolves.toBe(false)

    expect(warningSpy).toHaveBeenCalledWith(
      expect.stringContaining('status=500'),
    )
  })
})

describe('checkIssueComments', () => {
  it('is true when the user has commented on the issue', async () => {
    server.use(
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1/comments`,
        utils.mockResponse(200, issueListComments),
      ),
    )

    await expect(checkIssueComments(octokit, context, 1, 'some-user')).resolves.toBe(true)
  })

  it('is false when the user has not commented on the issue', async () => {
    server.use(
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1/comments`,
        utils.mockResponse(200, issueListComments),
      ),
    )

    await expect(checkIssueComments(octokit, context, 1, 'nobody')).resolves.toBe(false)
  })

  it('warns when listing comments fails', async () => {
    const warningSpy = vi.spyOn(core, 'warning')

    server.use(
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1/comments`,
        utils.mockResponse(500),
      ),
    )

    await expect(checkIssueComments(octokit, context, 1, 'some-user')).resolves.toBe(false)

    expect(warningSpy).toHaveBeenCalledWith(
      expect.stringContaining('status=500'),
    )
  })
})

describe('checkCommenterAuth', () => {
  it('is false when the user fails every check', async () => {
    server.use(
      http.get(
        `${utils.api}/orgs/Codertocat/members/some-user`,
        utils.mockResponse(404),
      ),
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/collaborators/some-user`,
        utils.mockResponse(404),
      ),
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1/comments`,
        utils.mockResponse(404),
      ),
    )

    await expect(checkCommenterAuth(octokit, context, 1, 'some-user')).resolves.toBe(false)
  })

  it('is true when the user has only commented previously', async () => {
    server.use(
      http.get(
        `${utils.api}/orgs/Codertocat/members/some-user`,
        utils.mockResponse(404),
      ),
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/collaborators/some-user`,
        utils.mockResponse(404),
      ),
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1/comments`,
        utils.mockResponse(200, issueListComments),
      ),
    )

    await expect(checkCommenterAuth(octokit, context, 1, 'some-user')).resolves.toBe(true)
  })
})

describe('getOrgCollabCommentUsers', () => {
  it('keeps only the users that pass a check', async () => {
    server.use(
      http.get(
        `${utils.api}/orgs/Codertocat/members/some-user`,
        utils.mockResponse(204),
      ),
      http.get(
        `${utils.api}/orgs/Codertocat/members/nobody`,
        utils.mockResponse(404),
      ),
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/collaborators/some-user`,
        utils.mockResponse(404),
      ),
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/collaborators/nobody`,
        utils.mockResponse(404),
      ),
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1/comments`,
        utils.mockResponse(404),
      ),
    )

    await expect(
      getOrgCollabCommentUsers(octokit, context, 1, ['some-user', 'nobody']),
    ).resolves.toEqual(['some-user'])
  })
})

describe('assertAuthorizedByOwnersOrMembership', () => {
  it('throws when fetching the OWNERS file fails with a non-404', async () => {
    server.use(
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/contents/OWNERS`,
        utils.mockResponse(500),
      ),
    )

    await expect(
      assertAuthorizedByOwnersOrMembership(octokit, context, 'approvers', 'Codertocat'),
    ).rejects.toThrow('error checking for an OWNERS file at the root of the repository')
  })

  it('throws when the OWNERS response has no content or encoding', async () => {
    server.use(
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/contents/OWNERS`,
        utils.mockResponse(200, { type: 'file', name: 'OWNERS', path: 'OWNERS' }),
      ),
    )

    await expect(
      assertAuthorizedByOwnersOrMembership(octokit, context, 'approvers', 'Codertocat'),
    ).rejects.toThrow('invalid OWNERS file returned from GitHub API')
  })

  it('throws when the OWNERS file has no entry for the role', async () => {
    server.use(
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/contents/OWNERS`,
        utils.mockResponse(200, ownersResponse('reviewers:\n- Codertocat\n')),
      ),
    )

    await expect(
      assertAuthorizedByOwnersOrMembership(octokit, context, 'approvers', 'Codertocat'),
    ).rejects.toThrow('Codertocat is not included in the approvers role in the OWNERS file')
  })

  it('resolves when the user holds the role in the OWNERS file', async () => {
    server.use(
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/contents/OWNERS`,
        utils.mockResponse(200, ownersResponse('approvers:\n- Codertocat\n')),
      ),
    )

    await expect(
      assertAuthorizedByOwnersOrMembership(octokit, context, 'approvers', 'Codertocat'),
    ).resolves.toBeUndefined()
  })

  it('falls back to membership when there is no OWNERS file', async () => {
    server.use(
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/contents/OWNERS`,
        utils.mockResponse(404),
      ),
      http.get(
        `${utils.api}/orgs/Codertocat/members/Codertocat`,
        utils.mockResponse(404),
      ),
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/collaborators/Codertocat`,
        utils.mockResponse(404),
      ),
    )

    await expect(
      assertAuthorizedByOwnersOrMembership(octokit, context, 'approvers', 'Codertocat'),
    ).rejects.toThrow('Codertocat is not a org member or collaborator')
  })
})
