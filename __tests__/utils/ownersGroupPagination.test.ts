import * as core from '@actions/core'
import { Octokit } from '@octokit/rest'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { assertAuthorizedByOwnersOrMembership } from '../../src/utils/auth'
import * as utils from '../testUtils'
import { prCommentEvent, prHandlers } from './ownersFixtures'

// The OWNERS group tests in owners.test.ts stub `octokit.paginate`; this file lets the
// real paginator walk a team's `Link` headers so the contract under test is the one
// expandGroups actually relies on: a membership page that cannot be read makes the
// whole group contribute nobody, instead of the members read so far being trusted.

const server = setupServer()
beforeAll(() => {
  utils.setupActionsEnv()
  server.listen(utils.failOnUnhandledRequest)
})
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

const octokit = new Octokit({ auth: 'some-token' })
const context = new utils.MockContext(prCommentEvent('/approve'))
const members = `${utils.api}/orgs/Codertocat/teams/maintainers/members`
const groupOwners = 'approvers:\n- "@codertocat/maintainers"\n'

function authorize(username: string) {
  utils.newRun()
  return assertAuthorizedByOwnersOrMembership(octokit, context, 'approvers', username)
}

/**
 * Serves the team's members two to a page: page one is always `dave`, page two is
 * `alice` or, with `failPageTwo`, a 500. Each page records the query it was asked for.
 */
function pagedTeam(seen: string[], failPageTwo = false) {
  return http.get(members, ({ request }) => {
    const url = new URL(request.url)
    const page = url.searchParams.get('page') ?? '1'
    seen.push(`page=${page}&per_page=${url.searchParams.get('per_page')}`)
    if (page === '1') {
      url.searchParams.set('page', '2')
      return HttpResponse.json([{ login: 'dave' }], { headers: { Link: `<${url}>; rel="next"` } })
    }
    if (failPageTwo) {
      return HttpResponse.json({ message: 'Server Error' }, { status: 500 })
    }
    return HttpResponse.json([{ login: 'alice' }])
  })
}

describe('owners groups read through the real paginator', () => {
  it('follows the Link header, so a member listed only on page two is an approver', async () => {
    const seen: string[] = []
    server.use(...prHandlers({ OWNERS: groupOwners }, ['src/file1.txt']), pagedTeam(seen))

    await expect(authorize('alice')).resolves.toBeUndefined()
    expect(seen).toEqual(['page=1&per_page=100', 'page=2&per_page=100'])
    expect(core.warning).not.toHaveBeenCalled()
  })

  it('authorizes a member on page one once every page has been read', async () => {
    server.use(...prHandlers({ OWNERS: groupOwners }, ['src/file1.txt']), pagedTeam([]))

    await expect(authorize('dave')).resolves.toBeUndefined()
    expect(core.warning).not.toHaveBeenCalled()
  })

  it('fails closed when a later page cannot be read: a page-one member is denied and the team is warned about', async () => {
    const seen: string[] = []
    server.use(...prHandlers({ OWNERS: groupOwners }, ['src/file1.txt']), pagedTeam(seen, true))

    await expect(authorize('dave')).rejects.toThrow('dave is not an approver for any changed file')

    expect(seen).toEqual(['page=1&per_page=100', 'page=2&per_page=100'])
    expect(core.warning).toHaveBeenCalledTimes(1)
    expect(core.warning).toHaveBeenCalledWith(
      'OWNERS: could not read the members of @codertocat/maintainers: HttpError: Server Error',
    )
  })

  it('does not fall back to organization membership when the group cannot be read', async () => {
    // the OWNERS file exists, so a page-one member is judged by it alone: no GET /orgs/{org}/members/{login}
    // is made (the unhandled-request guard would reject one), and the denial is the OWNERS one
    server.use(...prHandlers({ OWNERS: groupOwners }, ['src/file1.txt']), pagedTeam([], true))

    await expect(authorize('dave')).rejects.toThrow('dave is not an approver for any changed file')
  })
})
