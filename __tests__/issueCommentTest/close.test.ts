import { Buffer } from 'node:buffer'

import * as core from '@actions/core'
import { http } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { handleIssueComment } from '../../src/issueComment/handleIssueComment'

import issueCommentEvent from '../fixtures/issues/issueCommentEvent.json'

import * as utils from '../testUtils'

const server = setupServer()
beforeAll(() =>
  server.listen(utils.failOnUnhandledRequest),
)
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

describe('/close', () => {
  beforeEach(() => {
    utils.setupActionsEnv('/close')
    // the fixture's issue author and commenter are both Codertocat; authors may /close
    issueCommentEvent.issue.user.login = 'some-author'
  })

  it('closes the issue with /close', async () => {
    issueCommentEvent.comment.body = '/close much better title'

    server.use(
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/collaborators/Codertocat`,
        utils.mockResponse(204),
      ),
    )

    const observeReq = new utils.ObserveRequest()
    server.use(
      http.patch(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1`,
        utils.mockResponse(200, null, observeReq),
      ),
    )

    const commentContext = new utils.MockContext(issueCommentEvent)

    await handleIssueComment(commentContext)
    await observeReq.called()
    expect(await observeReq.body()).toEqual({
      state: 'closed',
    })
  })

  it('does not close the issue when commenter is neither a collaborator nor the author', async () => {
    issueCommentEvent.comment.body = '/close'

    server.use(
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/collaborators/Codertocat`,
        utils.mockResponse(404),
      ),
      ...utils.noOrgOrRepoConfigExcept(),
    )

    const observeReq = new utils.ObserveRequest()
    server.use(
      http.patch(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1`,
        utils.mockResponse(200, null, observeReq),
      ),
    )

    const commentContext = new utils.MockContext(issueCommentEvent)

    const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})
    await handleIssueComment(commentContext)
    await expect(observeReq.notCalled()).resolves.toBe('not called')
    expect(setFailed).not.toHaveBeenCalled()
  })

  it('lets the author close without checking collaborator status', async () => {
    issueCommentEvent.comment.body = '/close'
    issueCommentEvent.issue.user.login = issueCommentEvent.comment.user.login

    const observeAuth = new utils.ObserveRequest()
    const observeReq = new utils.ObserveRequest()
    server.use(
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/collaborators/Codertocat`,
        utils.mockResponse(404, null, observeAuth),
      ),
      http.patch(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1`,
        utils.mockResponse(200, null, observeReq),
      ),
    )

    const commentContext = new utils.MockContext(issueCommentEvent)

    const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})
    await handleIssueComment(commentContext)
    await observeReq.called()
    expect(await observeReq.body()).toEqual({ state: 'closed' })
    await expect(observeAuth.notCalled()).resolves.toBe('not called')
    expect(setFailed).not.toHaveBeenCalled()
  })

  it.each(['/close not-planned', '/close NOT-PLANNED', '/CLOSE Not-Planned'])('closes as not planned with %s', async (body) => {
    issueCommentEvent.comment.body = body

    server.use(
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/collaborators/Codertocat`,
        utils.mockResponse(204),
      ),
    )

    const observeReq = new utils.ObserveRequest()
    server.use(
      http.patch(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1`,
        utils.mockResponse(200, null, observeReq),
      ),
    )

    const commentContext = new utils.MockContext(issueCommentEvent)

    const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})
    await handleIssueComment(commentContext)
    await observeReq.called()
    expect(await observeReq.body()).toEqual({
      state: 'closed',
      state_reason: 'not_planned',
    })
    expect(setFailed).not.toHaveBeenCalled()
  })

  it('does not close as not planned when commenter is neither a collaborator nor the author', async () => {
    issueCommentEvent.comment.body = '/close not-planned'

    server.use(
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/collaborators/Codertocat`,
        utils.mockResponse(404),
      ),
      ...utils.noOrgOrRepoConfigExcept(),
    )

    const observeReq = new utils.ObserveRequest()
    server.use(
      http.patch(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1`,
        utils.mockResponse(200, null, observeReq),
      ),
    )

    const commentContext = new utils.MockContext(issueCommentEvent)

    const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})
    await handleIssueComment(commentContext)
    await expect(observeReq.notCalled()).resolves.toBe('not called')
    expect(setFailed).not.toHaveBeenCalled()
  })
})

describe('authorization.close for /close', () => {
  const repo = `${utils.api}/repos/Codertocat/Hello-World`
  let calls: string[]
  const recordCall = ({ request }: { request: Request }) => {
    calls.push(`${request.method} ${new URL(request.url).pathname}`)
  }

  beforeEach(() => {
    utils.setupActionsEnv('/close')
    calls = []
    server.events.on('request:start', recordCall)
  })

  // the server outlives the test; an unremoved listener would record every later request again
  afterEach(() => {
    server.events.removeListener('request:start', recordCall)
  })

  function prowYaml(text: string) {
    return [
      http.get(utils.contentsUrl('.github/prow.yaml'), utils.mockResponse(200, { type: 'file', encoding: 'base64', content: Buffer.from(text).toString('base64') })),
      ...utils.noOrgOrRepoConfigExcept('.github/prow.yaml'),
    ]
  }

  function membership(login: string, { member = false, collaborator = false } = {}) {
    return [
      http.get(`${utils.api}/orgs/Codertocat/members/${login}`, utils.mockResponse(member ? 204 : 404)),
      http.get(`${repo}/collaborators/${login}`, utils.mockResponse(collaborator ? 204 : 404)),
    ]
  }

  async function run(commenter: string, author = 'some-author') {
    const payload = structuredClone(issueCommentEvent)
    payload.comment.body = '/close'
    payload.comment.user.login = commenter
    payload.issue.user.login = author
    const update = new utils.ObserveRequest()
    server.use(http.patch(`${repo}/issues/1`, utils.mockResponse(200, null, update)))
    const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})
    await handleIssueComment(new utils.MockContext(payload))
    return { update, setFailed }
  }

  const configRead = (call: string) => call.includes('/contents/')

  it('admits a collaborator without reading the configuration', async () => {
    server.use(...membership('carla', { collaborator: true }))

    const { update, setFailed } = await run('carla')

    expect(await update.body()).toMatchObject({ state: 'closed' })
    expect(calls.filter(configRead)).toEqual([])
    expect(setFailed).not.toHaveBeenCalled()
  })

  it('admits the author under trusted without any authorization call', async () => {
    server.use(...prowYaml('authorization:\n  close: trusted\n'))

    const { update } = await run('some-author', 'some-author')

    expect(await update.body()).toMatchObject({ state: 'closed' })
    expect(calls).toEqual(['PATCH /repos/Codertocat/Hello-World/issues/1'])
  })

  it('under trusted admits a users login, in any case, after the collaborator check refuses', async () => {
    server.use(...prowYaml('authorization:\n  close: trusted\n  users: [FRIEND]\n'), ...membership('friend'))

    const { update, setFailed } = await run('friend')

    expect(await update.body()).toMatchObject({ state: 'closed' })
    expect(calls.filter(call => call.includes('/members/'))).toEqual([])
    expect(setFailed).not.toHaveBeenCalled()
  })

  it('under trusted admits a reviewer in the root OWNERS file', async () => {
    server.use(
      ...prowYaml('authorization:\n  close: trusted\n'),
      ...membership('rita'),
      http.get(`${repo}/contents/OWNERS`, utils.mockResponse(200, { type: 'file', encoding: 'base64', content: Buffer.from('reviewers:\n  - rita\n').toString('base64') })),
    )

    const { update } = await run('rita')

    expect(await update.body()).toMatchObject({ state: 'closed' })
  })

  it('under members admits an org member', async () => {
    server.use(...prowYaml('authorization:\n  close: members\n'), ...membership('maria', { member: true }))

    const { update } = await run('maria')

    expect(await update.body()).toMatchObject({ state: 'closed' })
  })

  it('under trusted refuses an outsider silently', async () => {
    server.use(
      ...prowYaml('authorization:\n  close: trusted\n  users: [friend]\n'),
      ...membership('outsider'),
      http.get(`${repo}/contents/OWNERS`, utils.mockResponse(404)),
    )

    const { update, setFailed } = await run('outsider')

    await expect(update.notCalled()).resolves.toBe('not called')
    expect(setFailed).not.toHaveBeenCalled()
  })

  it.each([
    ['a failed read', () => [http.get(utils.contentsUrl('.github/prow.yaml'), utils.mockResponse(500, { message: 'boom' })), ...utils.noOrgOrRepoConfigExcept('.github/prow.yaml')]],
    ['malformed yaml', () => prowYaml('authorization:\n  close: everyone\n')],
  ])('refuses an outsider silently, with a warning, when the configuration cannot be loaded: %s', async (_, handlers) => {
    const warning = vi.spyOn(core, 'warning').mockImplementation(() => {})
    server.use(...handlers(), ...membership('outsider'))

    const { update, setFailed } = await run('outsider')

    await expect(update.notCalled()).resolves.toBe('not called')
    expect(setFailed).not.toHaveBeenCalled()
    expect(warning).toHaveBeenCalledWith(expect.stringContaining('authorization: could not load prow config: '))
    // the organization tier keeps probing after the repository tier failed; let it finish inside this test
    await vi.waitFor(() => expect(calls).toContain('GET /repos/Codertocat/.github/contents/prow.yaml'))
  })

  it('under anyone admits an outsider', async () => {
    server.use(...prowYaml('authorization:\n  close: anyone\n'), ...membership('outsider'))

    const { update } = await run('outsider')

    expect(await update.body()).toMatchObject({ state: 'closed' })
    expect(calls.filter(call => call.includes('/members/'))).toEqual([])
  })
})
