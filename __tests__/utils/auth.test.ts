import { Buffer } from 'node:buffer'

import * as core from '@actions/core'
import { Octokit } from '@octokit/rest'
import { http } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  assertAuthorizedByOwnersOrMembership,
  assertPolicy,
  checkCollaborator,
  checkCommenterAuth,
  checkIssueComments,
  checkOrgMember,
  closePolicyAllows,
  getOrgCollabCommentUsers,
  policyAllows,
} from '../../src/utils/auth'
import { defaultAuthorization, resetProwConfigCache } from '../../src/utils/config'
import issueListComments from '../fixtures/issues/assign/issueListComments.json'
import issueCommentEvent from '../fixtures/issues/issueCommentEvent.json'

import * as utils from '../testUtils'

const server = setupServer()
beforeAll(() => {
  utils.setupActionsEnv()
  server.listen(utils.failOnUnhandledRequest)
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

  it('warns with status=unknown when the rejection is a plain string', async () => {
    const warningSpy = vi.spyOn(core, 'warning')

    vi.spyOn(octokit.orgs, 'checkMembershipForUser').mockRejectedValueOnce('socket hang up')

    await expect(checkOrgMember(octokit, context, 'some-user')).resolves.toBe(false)

    expect(warningSpy).toHaveBeenCalledWith(
      'encountered unexpected error: status=unknown, message=socket hang up',
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

  it('warns with status=unknown when the rejection has neither status nor message', async () => {
    const warningSpy = vi.spyOn(core, 'warning')

    vi.spyOn(octokit.repos, 'checkCollaborator').mockRejectedValueOnce({})

    await expect(checkCollaborator(octokit, context, 'some-user')).resolves.toBe(false)

    expect(warningSpy).toHaveBeenCalledWith(
      'encountered unexpected error checking collaborator status: status=unknown, message=[object Object]',
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

  it('warns with status=unknown when the rejection is an Error without a status', async () => {
    const warningSpy = vi.spyOn(core, 'warning')

    vi.spyOn(octokit.issues, 'listComments').mockRejectedValueOnce(new Error('network down'))

    await expect(checkIssueComments(octokit, context, 1, 'some-user')).resolves.toBe(false)

    expect(warningSpy).toHaveBeenCalledWith(
      'encountered unexpected error checking issue comments: status=unknown, message=network down',
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

  // Each helper swallows API errors and logs them, so the only way an error
  // escapes into checkCommenterAuth's own catch blocks is the logger throwing.
  it('wraps an error escaping the org membership check', async () => {
    vi.spyOn(core, 'warning').mockImplementation(() => {
      throw new Error('logger down')
    })
    vi.spyOn(octokit.orgs, 'checkMembershipForUser').mockRejectedValueOnce({ status: 500 })

    await expect(checkCommenterAuth(octokit, context, 1, 'some-user')).rejects.toThrow(
      'error in checking org member: Error: logger down',
    )
  })

  it('wraps an error escaping the collaborator check', async () => {
    vi.spyOn(core, 'warning').mockImplementation(() => {
      throw new Error('logger down')
    })
    vi.spyOn(octokit.orgs, 'checkMembershipForUser').mockRejectedValueOnce({ status: 404 })
    vi.spyOn(octokit.repos, 'checkCollaborator').mockRejectedValueOnce({ status: 500 })

    await expect(checkCommenterAuth(octokit, context, 1, 'some-user')).rejects.toThrow(
      'could not check collaborator: Error: logger down',
    )
  })

  it('wraps an error escaping the issue comments check', async () => {
    vi.spyOn(core, 'warning').mockImplementation(() => {
      throw new Error('logger down')
    })
    vi.spyOn(octokit.orgs, 'checkMembershipForUser').mockRejectedValueOnce({ status: 404 })
    vi.spyOn(octokit.repos, 'checkCollaborator').mockRejectedValueOnce({ status: 404 })
    vi.spyOn(octokit.issues, 'listComments').mockRejectedValueOnce({ status: 500 })

    await expect(checkCommenterAuth(octokit, context, 1, 'some-user')).rejects.toThrow(
      'could not check issue comments: Error: logger down',
    )
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

  it('wraps an error escaping any of the checks', async () => {
    vi.spyOn(core, 'warning').mockImplementation(() => {
      throw new Error('logger down')
    })
    vi.spyOn(octokit.orgs, 'checkMembershipForUser').mockRejectedValueOnce({ status: 500 })

    await expect(
      getOrgCollabCommentUsers(octokit, context, 1, ['some-user']),
    ).rejects.toThrow('could not get authorized user: Error: logger down')
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
      ...utils.noOrgOrRepoConfigExcept(),
    )

    await expect(
      assertAuthorizedByOwnersOrMembership(octokit, context, 'approvers', 'Codertocat'),
    ).rejects.toThrow('Codertocat is not a org member or collaborator')
  })
})

describe('authorization policies', () => {
  const repo = `${utils.api}/repos/Codertocat/Hello-World`
  let calls: string[]
  let inFlight = 0
  const recordCall = ({ request }: { request: Request }) => {
    calls.push(`${request.method} ${new URL(request.url).pathname}`)
    inFlight++
  }
  const endCall = () => {
    inFlight--
  }

  beforeEach(() => {
    resetProwConfigCache()
    calls = []
    server.events.on('request:start', recordCall)
    server.events.on('request:end', endCall)
  })

  // the server outlives the test; an unremoved listener would record every later request again. A failed
  // configuration load rejects while its sibling probes are still in flight, so wait for them first
  afterEach(async () => {
    await vi.waitFor(() => expect(inFlight).toBe(0))
    server.events.removeListener('request:start', recordCall)
    server.events.removeListener('request:end', endCall)
  })

  function membership({ member = false, collaborator = false }: { member?: boolean, collaborator?: boolean } = {}, login = 'Alice') {
    return [
      http.get(`${utils.api}/orgs/Codertocat/members/${login}`, utils.mockResponse(member ? 204 : 404)),
      http.get(`${repo}/collaborators/${login}`, utils.mockResponse(collaborator ? 204 : 404)),
    ]
  }

  function rootOwners(owners?: string) {
    return http.get(`${repo}/contents/OWNERS`, owners === undefined ? utils.mockResponse(404) : utils.mockResponse(200, ownersResponse(owners)))
  }

  function prowYaml(text: string) {
    return [
      http.get(utils.contentsUrl('.github/prow.yaml'), utils.mockResponse(200, { type: 'file', encoding: 'base64', content: Buffer.from(text).toString('base64') })),
      ...utils.noOrgOrRepoConfigExcept('.github/prow.yaml'),
    ]
  }

  const configReads = utils.configProbes.map((source) => {
    const [owner, path] = source.split(':')
    return `GET /repos/${owner}/contents/${encodeURIComponent(path)}`
  })
  // the repository probes stop at .github/prow.yaml, the first path
  const prowYamlReads = configReads.slice(0, 3)

  describe('policyAllows', () => {
    it('refuses an empty login under every policy without any API call', async () => {
      for (const policy of ['anyone', 'collaborators', 'members', 'trusted'] as const) {
        await expect(policyAllows(octokit, context, policy, '', ['']), policy).resolves.toBe(false)
      }
      expect(calls).toEqual([])
    })

    it('anyone admits without any API call', async () => {
      await expect(policyAllows(octokit, context, 'anyone', 'Alice', [])).resolves.toBe(true)
      expect(calls).toEqual([])
    })

    it.each([
      ['a users login', { users: ['alice'] }, { anyone: true, collaborators: false, members: false, trusted: true }],
      ['an org member', { member: true }, { anyone: true, collaborators: false, members: true, trusted: true }],
      ['a collaborator', { collaborator: true }, { anyone: true, collaborators: true, members: true, trusted: true }],
      ['a root OWNERS reviewer', { owners: 'reviewers:\n  - alice\n' }, { anyone: true, collaborators: false, members: false, trusted: true }],
      ['a root OWNERS approver', { owners: 'approvers:\n  - alice\n' }, { anyone: true, collaborators: false, members: false, trusted: true }],
      ['nobody in particular', { owners: 'approvers:\n  - bob\n' }, { anyone: true, collaborators: false, members: false, trusted: false }],
      ['nobody, with no root OWNERS file', {}, { anyone: true, collaborators: false, members: false, trusted: false }],
    ] as const)('%s', async (_, who, want) => {
      const fixture: { users?: readonly string[], member?: boolean, collaborator?: boolean, owners?: string } = who
      server.use(...membership(fixture), rootOwners(fixture.owners))

      for (const [policy, allowed] of Object.entries(want)) {
        await expect(policyAllows(octokit, context, policy as keyof typeof want, 'Alice', [...(fixture.users ?? [])]), policy).resolves.toBe(allowed)
      }
    })

    it('compares users and OWNERS logins case-insensitively', async () => {
      server.use(...membership({}, 'ALICE'), rootOwners('reviewers:\n  - Alice\n'))

      await expect(policyAllows(octokit, context, 'trusted', 'aLiCe', ['alice'])).resolves.toBe(true)
      await expect(policyAllows(octokit, context, 'trusted', 'ALICE', [])).resolves.toBe(true)
    })

    it('a users hit makes no API call', async () => {
      await expect(policyAllows(octokit, context, 'trusted', 'Alice', ['alice'])).resolves.toBe(true)
      expect(calls).toEqual([])
    })

    it('an org member never triggers the collaborator or OWNERS read', async () => {
      server.use(...membership({ member: true }))

      await expect(policyAllows(octokit, context, 'trusted', 'Alice', [])).resolves.toBe(true)
      expect(calls).toEqual(['GET /orgs/Codertocat/members/Alice'])
    })

    it('a collaborator never triggers the OWNERS read', async () => {
      server.use(...membership({ collaborator: true }))

      await expect(policyAllows(octokit, context, 'trusted', 'Alice', [])).resolves.toBe(true)
      expect(calls).toEqual(['GET /orgs/Codertocat/members/Alice', 'GET /repos/Codertocat/Hello-World/collaborators/Alice'])
    })

    it('collaborators reads only the collaborator check', async () => {
      server.use(...membership({ member: true }))

      await expect(policyAllows(octokit, context, 'collaborators', 'Alice', ['alice'])).resolves.toBe(false)
      expect(calls).toEqual(['GET /repos/Codertocat/Hello-World/collaborators/Alice'])
    })

    it('skips the checks the caller already ran', async () => {
      server.use(rootOwners())

      await expect(policyAllows(octokit, context, 'trusted', 'Alice', [], { member: true, collaborator: true })).resolves.toBe(false)
      await expect(policyAllows(octokit, context, 'collaborators', 'Alice', [], { collaborator: true })).resolves.toBe(false)
      expect(calls).toEqual(['GET /repos/Codertocat/Hello-World/contents/OWNERS'])
    })
  })

  describe('assertPolicy', () => {
    it('names the user, the command and the policy when it refuses', async () => {
      server.use(...membership())

      await expect(assertPolicy(octokit, context, { ...defaultAuthorization, labels: 'members' }, 'labels', 'Alice', '/kind'))
        .rejects
        .toThrow('Alice is not authorized to run /kind: authorization.labels is members')
    })

    it('resolves when the policy admits the user', async () => {
      await expect(assertPolicy(octokit, context, { ...defaultAuthorization, hold: 'trusted', users: ['alice'] }, 'hold', 'Alice', '/hold'))
        .resolves
        .toBeUndefined()
    })
  })

  describe('closePolicyAllows', () => {
    it('refuses under the default collaborators policy without repeating the collaborator check', async () => {
      server.use(...utils.noOrgOrRepoConfigExcept())

      await expect(closePolicyAllows(octokit, context, 'Alice')).resolves.toBe(false)
      expect(calls.sort()).toEqual([...configReads].sort())
    })

    it.each([
      ['a failed read', [http.get(utils.contentsUrl('.github/prow.yaml'), utils.mockResponse(500, { message: 'boom' })), ...utils.noOrgOrRepoConfigExcept('.github/prow.yaml')]],
      ['malformed yaml', prowYaml('authorization:\n  close: everyone\n')],
    ])('refuses with a warning, and no further call, when the configuration cannot be loaded: %s', async (_, handlers) => {
      const warning = vi.spyOn(core, 'warning').mockImplementation(() => {})
      server.use(...handlers)

      await expect(closePolicyAllows(octokit, context, 'Alice')).resolves.toBe(false)
      expect(warning).toHaveBeenCalledWith(expect.stringContaining('authorization: could not load prow config: '))
      // the organization tier keeps probing after the repository tier failed; let it finish inside this test
      await vi.waitFor(() => expect(calls).toContain('GET /repos/Codertocat/.github/contents/prow.yaml'))
      expect(calls.filter(call => !call.includes('/contents/'))).toEqual([])
    })

    it('anyone admits after reading the configuration', async () => {
      server.use(...prowYaml('authorization:\n  close: anyone\n'))

      await expect(closePolicyAllows(octokit, context, 'Alice')).resolves.toBe(true)
      expect(calls.sort()).toEqual([...prowYamlReads].sort())
    })

    it('members adds the org membership check', async () => {
      server.use(...prowYaml('authorization:\n  close: members\n'), ...membership({ member: true }))

      await expect(closePolicyAllows(octokit, context, 'Alice')).resolves.toBe(true)
      expect(calls.slice(prowYamlReads.length)).toEqual(['GET /orgs/Codertocat/members/Alice'])
    })

    it('trusted tries users, then org membership, then the root OWNERS file', async () => {
      server.use(...prowYaml('authorization:\n  close: trusted\n  users: [Bob]\n'), ...membership(), rootOwners('reviewers:\n  - alice\n'))

      await expect(closePolicyAllows(octokit, context, 'Alice')).resolves.toBe(true)
      expect(calls.slice(prowYamlReads.length)).toEqual(['GET /orgs/Codertocat/members/Alice', 'GET /repos/Codertocat/Hello-World/contents/OWNERS'])

      calls = []
      await expect(closePolicyAllows(octokit, context, 'BOB')).resolves.toBe(true)
      expect(calls).toEqual([])
    })
  })

  describe('the review fallback of assertAuthorizedByOwnersOrMembership', () => {
    it.each([
      ['an org member', { member: true }],
      ['a collaborator', { collaborator: true }],
    ])('admits %s without reading the configuration', async (_, who) => {
      server.use(rootOwners(), ...membership(who))

      await expect(assertAuthorizedByOwnersOrMembership(octokit, context, 'reviewers', 'Alice')).resolves.toBeUndefined()
      expect(calls).toEqual([
        'GET /repos/Codertocat/Hello-World/contents/OWNERS',
        'GET /orgs/Codertocat/members/Alice',
        'GET /repos/Codertocat/Hello-World/collaborators/Alice',
      ])
    })

    it('under the default members policy reads the configuration only to refuse, with the same message', async () => {
      server.use(rootOwners(), ...membership(), ...prowYaml('authorization:\n  users: [alice]\n'))

      await expect(assertAuthorizedByOwnersOrMembership(octokit, context, 'reviewers', 'Alice'))
        .rejects
        .toThrow(/^Alice is not a org member or collaborator$/)
      expect(calls.slice(0, 3)).toEqual([
        'GET /repos/Codertocat/Hello-World/contents/OWNERS',
        'GET /orgs/Codertocat/members/Alice',
        'GET /repos/Codertocat/Hello-World/collaborators/Alice',
      ])
      expect(calls.slice(3).sort()).toEqual([...prowYamlReads].sort())
    })

    it('falls back to the members message, with a warning, when the configuration cannot be loaded', async () => {
      const warning = vi.spyOn(core, 'warning').mockImplementation(() => {})
      server.use(rootOwners(), ...membership(), ...prowYaml('authorization:\n  review: anyone\n  users: [alice]\n'))

      await expect(assertAuthorizedByOwnersOrMembership(octokit, context, 'reviewers', 'Alice'))
        .rejects
        .toThrow(/^Alice is not a org member or collaborator$/)
      expect(warning).toHaveBeenCalledWith(expect.stringContaining('authorization: could not load prow config: '))
      expect(warning).toHaveBeenCalledWith(expect.stringContaining('authorization.review must be one of members, trusted'))
    })

    it('under trusted admits a users login after membership refuses', async () => {
      server.use(rootOwners(), ...membership(), ...prowYaml('authorization:\n  review: trusted\n  users: [ALICE]\n'))

      await expect(assertAuthorizedByOwnersOrMembership(octokit, context, 'approvers', 'Alice')).resolves.toBeUndefined()
    })

    it('under trusted refuses anyone else with a message naming authorization.users', async () => {
      server.use(rootOwners(), ...membership(), ...prowYaml('authorization:\n  review: trusted\n  users: [bob]\n'))

      await expect(assertAuthorizedByOwnersOrMembership(octokit, context, 'reviewers', 'Alice'))
        .rejects
        .toThrow('Alice is not a org member, collaborator or listed in authorization.users')
    })

    it('under trusted, a repository with OWNERS files still refuses a users-only login without reading the configuration', async () => {
      server.use(rootOwners('approvers:\n  - bob\n'))

      await expect(assertAuthorizedByOwnersOrMembership(octokit, context, 'approvers', 'Alice'))
        .rejects
        .toThrow('Alice is not included in the approvers role in the OWNERS file')
      expect(calls).toEqual(['GET /repos/Codertocat/Hello-World/contents/OWNERS'])
    })
  })
})
