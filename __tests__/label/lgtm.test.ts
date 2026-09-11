import { Buffer } from 'node:buffer'

import * as core from '@actions/core'
import { http } from 'msw'

import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { handleIssueComment } from '../../src/issueComment/handleIssueComment'

import issuePayload from '../fixtures/issues/issue.json'

import issueCommentEvent from '../fixtures/issues/issueCommentEvent.json'
import * as utils from '../testUtils'
import { prCommentEvent, prHandlers } from '../utils/ownersFixtures'

const server = setupServer()
beforeAll(() =>
  server.listen({
    onUnhandledRequest: 'error',
  }),
)
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

describe('lgtm', () => {
  beforeEach(() => {
    utils.setupActionsEnv('/lgtm')
    // the fixture's issue author and commenter are both Codertocat; an author cannot /lgtm
    issueCommentEvent.issue.user.login = 'some-author'
  })

  it('labels the issue with the lgtm label', async () => {
    issueCommentEvent.comment.body = '/lgtm'
    const commentContext = new utils.MockContext(issueCommentEvent)

    const observeReq = new utils.ObserveRequest()
    server.use(
      http.post(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1/labels`,
        utils.mockResponse(200, null, observeReq),
      ),
    )

    server.use(
      http.get(
        `${utils.api}/orgs/Codertocat/members/Codertocat`,
        utils.mockResponse(204),
      ),
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/collaborators/Codertocat`,
        utils.mockResponse(404),
      ),
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/contents/OWNERS`,
        utils.mockResponse(404),
      ),
    )

    await handleIssueComment(commentContext)
    await observeReq.called()
    expect(await observeReq.body()).toMatchObject({
      labels: ['lgtm'],
    })
  })

  it('removes the lgtm label with /lgtm cancel', async () => {
    issueCommentEvent.comment.body = '/lgtm cancel'
    const commentContext = new utils.MockContext(issueCommentEvent)

    const payload = structuredClone(issuePayload)
    payload.labels.push({
      id: 1,
      node_id: '123',
      url: 'https://api.github.com/repos/octocat/Hello-World/labels/lgtm',
      name: 'lgtm',
      description: 'looks good to me',
      color: 'f29513',
      default: true,
    })

    const observeReq = new utils.ObserveRequest()
    server.use(
      http.delete(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1/labels/lgtm`,
        utils.mockResponse(200, null, observeReq),
      ),
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1`,
        utils.mockResponse(200, payload),
      ),
      http.get(
        `${utils.api}/orgs/Codertocat/members/Codertocat`,
        utils.mockResponse(204),
      ),
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/collaborators/Codertocat`,
        utils.mockResponse(404),
      ),
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/contents/OWNERS`,
        utils.mockResponse(404),
      ),
    )

    await handleIssueComment(commentContext)
    await expect(observeReq.called()).resolves.toBe('called')
  })

  it('removes the lgtm label with /remove-lgtm', async () => {
    issueCommentEvent.comment.body = '/remove-lgtm'
    const commentContext = new utils.MockContext(issueCommentEvent)

    const payload = structuredClone(issuePayload)
    payload.labels.push({
      id: 1,
      node_id: '123',
      url: 'https://api.github.com/repos/octocat/Hello-World/labels/lgtm',
      name: 'lgtm',
      description: 'looks good to me',
      color: 'f29513',
      default: true,
    })

    const observeDelete = new utils.ObserveRequest()
    const observeAdd = new utils.ObserveRequest()
    server.use(
      http.delete(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1/labels/lgtm`,
        utils.mockResponse(200, null, observeDelete),
      ),
      http.post(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1/labels`,
        utils.mockResponse(200, null, observeAdd),
      ),
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1`,
        utils.mockResponse(200, payload),
      ),
      http.get(
        `${utils.api}/orgs/Codertocat/members/Codertocat`,
        utils.mockResponse(204),
      ),
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/collaborators/Codertocat`,
        utils.mockResponse(404),
      ),
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/contents/OWNERS`,
        utils.mockResponse(404),
      ),
    )

    const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})
    await handleIssueComment(commentContext)
    await expect(observeDelete.called()).resolves.toBe('called')
    await expect(observeAdd.notCalled()).resolves.toBe('not called')
    expect(setFailed).not.toHaveBeenCalled()
  })

  it('does not remove the lgtm label with /remove-lgtm from an unauthorized user', async () => {
    issueCommentEvent.comment.body = '/remove-lgtm'
    const commentContext = new utils.MockContext(issueCommentEvent)

    const wantErr = `Codertocat is not a org member or collaborator`

    const observeDelete = new utils.ObserveRequest()
    const observeComment = new utils.ObserveRequest()
    server.use(
      http.delete(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1/labels/lgtm`,
        utils.mockResponse(200, null, observeDelete),
      ),
      http.post(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1/comments`,
        utils.mockResponse(200, null, observeComment),
      ),
      http.get(
        `${utils.api}/orgs/Codertocat/members/Codertocat`,
        utils.mockResponse(404),
      ),
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/collaborators/Codertocat`,
        utils.mockResponse(404),
      ),
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/contents/OWNERS`,
        utils.mockResponse(404),
      ),
    )

    const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})
    await handleIssueComment(commentContext)
    await observeComment.called()
    expect(await observeComment.body().then(body => body.body)).toContain(wantErr)
    await expect(observeDelete.notCalled()).resolves.toBe('not called')
    expect(setFailed).toHaveBeenCalledWith(expect.stringContaining(wantErr))
  })

  it('does not issue a removal with /lgtm cancel when lgtm is absent', async () => {
    issueCommentEvent.comment.body = '/lgtm cancel'
    const commentContext = new utils.MockContext(issueCommentEvent)

    const observeReq = new utils.ObserveRequest()
    server.use(
      http.delete(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1/labels/lgtm`,
        utils.mockResponse(200, null, observeReq),
      ),
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1`,
        utils.mockResponse(200, issuePayload),
      ),
      http.get(
        `${utils.api}/orgs/Codertocat/members/Codertocat`,
        utils.mockResponse(204),
      ),
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/collaborators/Codertocat`,
        utils.mockResponse(404),
      ),
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/contents/OWNERS`,
        utils.mockResponse(404),
      ),
    )

    const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})
    await handleIssueComment(commentContext)
    await expect(observeReq.notCalled()).resolves.toBe('not called')
    expect(setFailed).not.toHaveBeenCalled()
  })

  it.each([
    ['/lgtm\n/lgtm cancel'],
    ['/lgtm cancel\n/lgtm'],
  ])('cancel wins when a comment carries both /lgtm and /lgtm cancel: %j', async (body) => {
    issueCommentEvent.comment.body = body
    const commentContext = new utils.MockContext(issueCommentEvent)

    const payload = structuredClone(issuePayload)
    payload.labels.push({ ...payload.labels[0], name: 'lgtm' })

    const observeDelete = new utils.ObserveRequest()
    const observeAdd = new utils.ObserveRequest()
    server.use(
      http.delete(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1/labels/lgtm`,
        utils.mockResponse(200, null, observeDelete),
      ),
      http.post(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1/labels`,
        utils.mockResponse(200, null, observeAdd),
      ),
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1`,
        utils.mockResponse(200, payload),
      ),
      http.get(
        `${utils.api}/orgs/Codertocat/members/Codertocat`,
        utils.mockResponse(204),
      ),
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/collaborators/Codertocat`,
        utils.mockResponse(404),
      ),
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/contents/OWNERS`,
        utils.mockResponse(404),
      ),
    )

    const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})
    await handleIssueComment(commentContext)
    await expect(observeDelete.called()).resolves.toBe('called')
    await expect(observeAdd.notCalled()).resolves.toBe('not called')
    expect(setFailed).not.toHaveBeenCalled()
  })

  it('adds label if commenter is collaborator', async () => {
    issueCommentEvent.comment.body = '/lgtm'
    const commentContext = new utils.MockContext(issueCommentEvent)

    const observeReq = new utils.ObserveRequest()
    server.use(
      http.post(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1/labels`,
        utils.mockResponse(200, null, observeReq),
      ),
    )

    server.use(
      http.get(
        `${utils.api}/orgs/Codertocat/members/Codertocat`,
        utils.mockResponse(404),
      ),
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/collaborators/Codertocat`,
        utils.mockResponse(204),
      ),
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/contents/OWNERS`,
        utils.mockResponse(404),
      ),
    )

    await handleIssueComment(commentContext)
    await observeReq.called()
    expect(await observeReq.body()).toMatchObject({
      labels: ['lgtm'],
    })
  })

  it('fails if commenter is not reviewer in OWNERS', async () => {
    const owners = Buffer.from(
      `
approvers:
- Codertocat
`,
    ).toString('base64')

    const contentResponse = {
      type: 'file',
      encoding: 'base64',
      size: 4096,
      name: 'OWNERS',
      path: 'OWNERS',
      content: owners,
    }

    server.use(
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/contents/OWNERS`,
        utils.mockResponse(200, contentResponse),
      ),
    )

    const wantErr = `Codertocat is not included in the reviewers role in the OWNERS file`

    // Mock the reply that the user is not authorized
    const observeReq = new utils.ObserveRequest()
    server.use(
      http.post(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1/comments`,
        utils.mockResponse(200, null, observeReq),
      ),
    )

    issueCommentEvent.comment.body = '/lgtm'
    const commentContext = new utils.MockContext(issueCommentEvent)

    await handleIssueComment(commentContext)
    await observeReq.called()
    expect(await observeReq.body().then(body => body.body)).toContain(wantErr)
  })

  it('fails if commenter is not org member or collaborator', async () => {
    const wantErr = `Codertocat is not a org member or collaborator`

    // Mock the reply that the user is not authorized
    const observeReq = new utils.ObserveRequest()
    server.use(
      http.post(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1/comments`,
        utils.mockResponse(200, null, observeReq),
      ),
    )

    server.use(
      http.get(
        `${utils.api}/orgs/Codertocat/members/Codertocat`,
        utils.mockResponse(404),
      ),
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/collaborators/Codertocat`,
        utils.mockResponse(404),
      ),
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/contents/OWNERS`,
        utils.mockResponse(404),
      ),
    )

    issueCommentEvent.comment.body = '/lgtm'
    const commentContext = new utils.MockContext(issueCommentEvent)

    await handleIssueComment(commentContext)
    await observeReq.called()
    expect(await observeReq.body().then(body => body.body)).toContain(wantErr)
  })

  it('adds label if commenter is reviewer in OWNERS', async () => {
    issueCommentEvent.comment.body = '/lgtm'
    const commentContext = new utils.MockContext(issueCommentEvent)

    const observeReq = new utils.ObserveRequest()
    server.use(
      http.post(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1/labels`,
        utils.mockResponse(200, null, observeReq),
      ),
    )

    const owners = Buffer.from(
      `
reviewers:
- Codertocat
`,
    ).toString('base64')

    const contentResponse = {
      type: 'file',
      encoding: 'base64',
      size: 4096,
      name: 'OWNERS',
      path: 'OWNERS',
      content: owners,
    }

    server.use(
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/contents/OWNERS`,
        utils.mockResponse(200, contentResponse),
      ),
    )

    await handleIssueComment(commentContext)
    await observeReq.called()
    expect(await observeReq.body()).toMatchObject({
      labels: ['lgtm'],
    })
  })

  it('still fails with the authorization error when the reply also fails', async () => {
    server.use(
      http.get(
        `${utils.api}/orgs/Codertocat/members/Codertocat`,
        utils.mockResponse(404),
      ),
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/collaborators/Codertocat`,
        utils.mockResponse(404),
      ),
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/contents/OWNERS`,
        utils.mockResponse(404),
      ),
      http.post(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1/comments`,
        utils.mockResponse(500),
      ),
    )

    const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})
    const logError = vi.spyOn(core, 'error').mockImplementation(() => {})

    issueCommentEvent.comment.body = '/lgtm'
    const commentContext = new utils.MockContext(issueCommentEvent)

    await handleIssueComment(commentContext)

    expect(logError).toHaveBeenCalledWith(
      expect.stringContaining('Could not comment with an auth error'),
    )
    expect(setFailed).toHaveBeenCalledWith(
      expect.stringContaining('not a org member or collaborator'),
    )
  })

  it('labels the issue with /LGTM', async () => {
    issueCommentEvent.comment.body = '/LGTM'
    const commentContext = new utils.MockContext(issueCommentEvent)

    const observeReq = new utils.ObserveRequest()
    server.use(
      http.post(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1/labels`,
        utils.mockResponse(200, null, observeReq),
      ),
      http.get(
        `${utils.api}/orgs/Codertocat/members/Codertocat`,
        utils.mockResponse(204),
      ),
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/collaborators/Codertocat`,
        utils.mockResponse(404),
      ),
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/contents/OWNERS`,
        utils.mockResponse(404),
      ),
    )

    const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})
    await handleIssueComment(commentContext)
    await observeReq.called()
    expect(await observeReq.body()).toMatchObject({ labels: ['lgtm'] })
    expect(setFailed).not.toHaveBeenCalled()
  })

  it('removes the lgtm label with /Lgtm CANCEL', async () => {
    issueCommentEvent.comment.body = '/Lgtm CANCEL'
    const commentContext = new utils.MockContext(issueCommentEvent)

    const payload = structuredClone(issuePayload)
    payload.labels.push({ ...payload.labels[0], name: 'lgtm' })

    const observeDelete = new utils.ObserveRequest()
    const observeAdd = new utils.ObserveRequest()
    server.use(
      http.delete(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1/labels/lgtm`,
        utils.mockResponse(200, null, observeDelete),
      ),
      http.post(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1/labels`,
        utils.mockResponse(200, null, observeAdd),
      ),
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1`,
        utils.mockResponse(200, payload),
      ),
      http.get(
        `${utils.api}/orgs/Codertocat/members/Codertocat`,
        utils.mockResponse(204),
      ),
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/collaborators/Codertocat`,
        utils.mockResponse(404),
      ),
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/contents/OWNERS`,
        utils.mockResponse(404),
      ),
    )

    const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})
    await handleIssueComment(commentContext)
    await expect(observeDelete.called()).resolves.toBe('called')
    await expect(observeAdd.notCalled()).resolves.toBe('not called')
    expect(setFailed).not.toHaveBeenCalled()
  })

  describe('by the author', () => {
    beforeEach(() => {
      issueCommentEvent.issue.user.login = issueCommentEvent.comment.user.login
    })

    it('refuses /lgtm on their own PR even when they are a reviewer', async () => {
      issueCommentEvent.comment.body = '/lgtm'
      const commentContext = new utils.MockContext(issueCommentEvent)

      const wantErr = 'you cannot LGTM your own PR.'

      const observeAdd = new utils.ObserveRequest()
      const observeComment = new utils.ObserveRequest()
      server.use(
        http.post(
          `${utils.api}/repos/Codertocat/Hello-World/issues/1/labels`,
          utils.mockResponse(200, null, observeAdd),
        ),
        http.post(
          `${utils.api}/repos/Codertocat/Hello-World/issues/1/comments`,
          utils.mockResponse(200, null, observeComment),
        ),
        http.get(
          `${utils.api}/orgs/Codertocat/members/Codertocat`,
          utils.mockResponse(204),
        ),
        http.get(
          `${utils.api}/repos/Codertocat/Hello-World/collaborators/Codertocat`,
          utils.mockResponse(204),
        ),
        http.get(
          `${utils.api}/repos/Codertocat/Hello-World/contents/OWNERS`,
          utils.mockResponse(404),
        ),
      )

      const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})
      await handleIssueComment(commentContext)
      await observeComment.called()
      expect(await observeComment.body().then(body => body.body)).toBe(wantErr)
      await expect(observeAdd.notCalled()).resolves.toBe('not called')
      expect(setFailed).toHaveBeenCalledWith(expect.stringContaining(wantErr))
    })

    it('lets them /lgtm cancel without reviewer authorization', async () => {
      issueCommentEvent.comment.body = '/lgtm cancel'
      const commentContext = new utils.MockContext(issueCommentEvent)

      const payload = structuredClone(issuePayload)
      payload.labels.push({ ...payload.labels[0], name: 'lgtm' })

      const observeDelete = new utils.ObserveRequest()
      const observeComment = new utils.ObserveRequest()
      server.use(
        http.delete(
          `${utils.api}/repos/Codertocat/Hello-World/issues/1/labels/lgtm`,
          utils.mockResponse(200, null, observeDelete),
        ),
        http.post(
          `${utils.api}/repos/Codertocat/Hello-World/issues/1/comments`,
          utils.mockResponse(200, null, observeComment),
        ),
        http.get(
          `${utils.api}/repos/Codertocat/Hello-World/issues/1`,
          utils.mockResponse(200, payload),
        ),
        http.get(
          `${utils.api}/orgs/Codertocat/members/Codertocat`,
          utils.mockResponse(404),
        ),
        http.get(
          `${utils.api}/repos/Codertocat/Hello-World/collaborators/Codertocat`,
          utils.mockResponse(404),
        ),
        http.get(
          `${utils.api}/repos/Codertocat/Hello-World/contents/OWNERS`,
          utils.mockResponse(404),
        ),
      )

      const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})
      await handleIssueComment(commentContext)
      await expect(observeDelete.called()).resolves.toBe('called')
      await expect(observeComment.notCalled()).resolves.toBe('not called')
      expect(setFailed).not.toHaveBeenCalled()
    })

    it('lets them /remove-lgtm without reviewer authorization', async () => {
      issueCommentEvent.comment.body = '/remove-lgtm'
      const commentContext = new utils.MockContext(issueCommentEvent)

      const payload = structuredClone(issuePayload)
      payload.labels.push({ ...payload.labels[0], name: 'lgtm' })

      const observeDelete = new utils.ObserveRequest()
      const observeAuth = new utils.ObserveRequest()
      server.use(
        http.delete(
          `${utils.api}/repos/Codertocat/Hello-World/issues/1/labels/lgtm`,
          utils.mockResponse(200, null, observeDelete),
        ),
        http.get(
          `${utils.api}/repos/Codertocat/Hello-World/issues/1`,
          utils.mockResponse(200, payload),
        ),
        http.get(
          `${utils.api}/repos/Codertocat/Hello-World/contents/OWNERS`,
          utils.mockResponse(404, null, observeAuth),
        ),
      )

      const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})
      await handleIssueComment(commentContext)
      await expect(observeDelete.called()).resolves.toBe('called')
      await expect(observeAuth.notCalled()).resolves.toBe('not called')
      expect(setFailed).not.toHaveBeenCalled()
    })
  })

  it('adds label on a PR when the commenter reviews any changed file', async () => {
    const commentContext = new utils.MockContext(prCommentEvent('/lgtm', 'ryan'))

    const observeReq = new utils.ObserveRequest()
    server.use(
      http.post(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1/labels`,
        utils.mockResponse(200, null, observeReq),
      ),
      ...prHandlers(
        { 'OWNERS': 'approvers:\n- alice\n', 'sdk/OWNERS': 'reviewers:\n- ryan\n' },
        ['sdk/x.go', 'docs/y.md'],
      ),
    )

    const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})
    await handleIssueComment(commentContext)
    await observeReq.called()
    expect(await observeReq.body()).toMatchObject({ labels: ['lgtm'] })
    expect(setFailed).not.toHaveBeenCalled()
  })

  it('fails on a PR when the commenter reviews none of the changed files', async () => {
    const commentContext = new utils.MockContext(prCommentEvent('/lgtm', 'ryan'))

    const wantErr = 'ryan is not a reviewer or approver for any changed file'

    const observeAdd = new utils.ObserveRequest()
    const observeComment = new utils.ObserveRequest()
    server.use(
      http.post(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1/labels`,
        utils.mockResponse(200, null, observeAdd),
      ),
      http.post(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1/comments`,
        utils.mockResponse(200, null, observeComment),
      ),
      ...prHandlers(
        { 'OWNERS': 'approvers:\n- alice\n', 'sdk/OWNERS': 'reviewers:\n- ryan\n' },
        ['docs/y.md'],
      ),
    )

    const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})
    await handleIssueComment(commentContext)
    await observeComment.called()
    expect(await observeComment.body().then(body => body.body)).toContain(wantErr)
    await expect(observeAdd.notCalled()).resolves.toBe('not called')
    expect(setFailed).toHaveBeenCalledWith(expect.stringContaining(wantErr))
  })

  it('still rejects /lgtm cancel from a non-author who is not a reviewer', async () => {
    issueCommentEvent.comment.body = '/lgtm cancel'
    const commentContext = new utils.MockContext(issueCommentEvent)

    const wantErr = `Codertocat is not a org member or collaborator`

    const observeDelete = new utils.ObserveRequest()
    const observeComment = new utils.ObserveRequest()
    server.use(
      http.delete(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1/labels/lgtm`,
        utils.mockResponse(200, null, observeDelete),
      ),
      http.post(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1/comments`,
        utils.mockResponse(200, null, observeComment),
      ),
      http.get(
        `${utils.api}/orgs/Codertocat/members/Codertocat`,
        utils.mockResponse(404),
      ),
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/collaborators/Codertocat`,
        utils.mockResponse(404),
      ),
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/contents/OWNERS`,
        utils.mockResponse(404),
      ),
    )

    const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})
    await handleIssueComment(commentContext)
    await observeComment.called()
    expect(await observeComment.body().then(body => body.body)).toContain(wantErr)
    await expect(observeDelete.notCalled()).resolves.toBe('not called')
    expect(setFailed).toHaveBeenCalledWith(expect.stringContaining(wantErr))
  })
})
