import { Buffer } from 'node:buffer'

import * as core from '@actions/core'
import { http } from 'msw'

import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { handleIssueComment } from '../../src/issueComment/handleIssueComment'

import issuePayload from '../fixtures/issues/issue.json'

import issueCommentEvent from '../fixtures/issues/issueCommentEvent.json'
import labelFileContents from '../fixtures/labels/labelFileContentsResp.json'
import * as utils from '../testUtils'
import { prCommentEvent, prHandlers } from '../utils/ownersFixtures'

const server = setupServer()
beforeAll(() =>
  server.listen({
    onUnhandledRequest: 'error',
  }),
)
// a label command is followed by the needs-* re-check and the merge gate: no prow.yaml in any tier, no OWNERS files
beforeEach(() => server.use(...utils.noOrgOrRepoConfigExcept(), utils.defaultBranchTree()))
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
      utils.repoHasLabels(['lgtm']),
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
      utils.repoHasLabels(['lgtm']),
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
      utils.repoHasLabels(['lgtm']),
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
      utils.repoHasLabels(['lgtm']),
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
      utils.repoHasLabels(['lgtm']),
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
      utils.repoHasLabels(['lgtm']),
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
      utils.repoHasLabels(['lgtm']),
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
        utils.repoHasLabels(['lgtm']),
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
      utils.repoHasLabels(['lgtm']),
      ...prHandlers(
        { 'OWNERS': 'approvers:\n- alice\n', 'sdk/OWNERS': 'reviewers:\n- ryan\n' },
        ['sdk/x.go', 'docs/y.md'],
      ),
      http.post(`${utils.api}/repos/Codertocat/Hello-World/statuses/headsha`, utils.mockResponse(201, {})),
      utils.lgtmStatus('headsha'),
    )

    const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})
    await handleIssueComment(commentContext)
    await observeReq.called()
    expect(await observeReq.body()).toMatchObject({ labels: ['lgtm'] })
    expect(setFailed).not.toHaveBeenCalled()
  })

  describe('bound to the head commit', () => {
    const repo = `${utils.api}/repos/Codertocat/Hello-World`
    let calls: string[]

    beforeEach(() => {
      calls = []
      server.events.on('request:start', ({ request }) => {
        calls.push(`${request.method} ${new URL(request.url).pathname}`)
      })
      server.use(
        http.get(`${utils.api}/orgs/Codertocat/members/Codertocat`, utils.mockResponse(204)),
        http.get(`${repo}/collaborators/Codertocat`, utils.mockResponse(404)),
        utils.repoHasLabels(['lgtm']),
        utils.lgtmStatus('headsha'),
      )
    })

    it('/lgtm on a pull request reads it, records the prow/lgtm status on its head, then labels', async () => {
      const status = new utils.ObserveRequest()
      const label = new utils.ObserveRequest()
      server.use(
        ...prHandlers({}, ['src/file1.txt'], { labels: [{ name: 'lgtm' }] }),
        http.post(`${repo}/statuses/headsha`, utils.mockResponse(201, {}, status)),
        http.post(`${repo}/issues/1/labels`, utils.mockResponse(200, [], label)),
        http.put(`${repo}/pulls/1/merge`, utils.mockResponse(200, { merged: true })),
      )
      const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})

      await handleIssueComment(new utils.MockContext(prCommentEvent('/lgtm')))

      await expect(status.called()).resolves.toBe('called')
      await expect(label.called()).resolves.toBe('called')
      expect(await status.body()).toEqual({
        state: 'success',
        context: 'prow/lgtm',
        description: 'lgtm by Codertocat at headsha',
        target_url: 'https://github.com/Codertocat/Hello-World/issues/1#issuecomment-492700400',
      })
      const pull = calls.indexOf('GET /repos/Codertocat/Hello-World/pulls/1')
      const bind = calls.indexOf('POST /repos/Codertocat/Hello-World/statuses/headsha')
      const add = calls.indexOf('POST /repos/Codertocat/Hello-World/issues/1/labels')
      expect(pull).toBeGreaterThanOrEqual(0)
      expect(bind).toBeGreaterThan(pull)
      expect(add).toBeGreaterThan(bind)
      // the pull request read is the one the authorization already made; binding costs one status post
      expect(calls.filter(call => call === 'GET /repos/Codertocat/Hello-World/pulls/1').length).toBeLessThanOrEqual(2)
      expect(setFailed).not.toHaveBeenCalled()
    })

    it('a 403 on the status fails the command with the permission to grant and applies no label', async () => {
      const label = new utils.ObserveRequest()
      const reply = new utils.ObserveRequest()
      server.use(
        ...prHandlers({}, ['src/file1.txt']),
        http.post(`${repo}/statuses/headsha`, utils.mockResponse(403, { message: 'Resource not accessible by integration' })),
        http.post(`${repo}/issues/1/labels`, utils.mockResponse(200, [], label)),
        http.post(`${repo}/issues/1/comments`, utils.mockResponse(201, {}, reply)),
      )
      const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})
      vi.spyOn(core, 'error').mockImplementation(() => {})

      await handleIssueComment(new utils.MockContext(prCommentEvent('/lgtm')))

      const wantErr = 'cannot bind lgtm to the commit: grant `statuses: write` to the workflow (or set `lgtm.bind_to_commit: false`)'
      await expect(reply.called()).resolves.toBe('called')
      expect(await reply.body().then(body => body.body)).toBe(wantErr)
      await expect(label.notCalled()).resolves.toBe('not called')
      expect(setFailed).toHaveBeenCalledWith(expect.stringContaining(wantErr))
    })

    it('any other status failure fails the command and applies no label', async () => {
      const label = new utils.ObserveRequest()
      server.use(
        ...prHandlers({}, ['src/file1.txt']),
        http.post(`${repo}/statuses/headsha`, utils.mockResponse(500, { message: 'boom' })),
        http.post(`${repo}/issues/1/labels`, utils.mockResponse(200, [], label)),
        http.post(`${repo}/issues/1/comments`, utils.mockResponse(201, {})),
      )
      const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})
      vi.spyOn(core, 'error').mockImplementation(() => {})

      await handleIssueComment(new utils.MockContext(prCommentEvent('/lgtm')))

      await expect(label.notCalled()).resolves.toBe('not called')
      expect(setFailed).toHaveBeenCalledWith(expect.stringContaining('could not bind lgtm to headsha'))
    })

    it('lgtm.bind_to_commit: false applies the label with no status call at all', async () => {
      const file = structuredClone(labelFileContents)
      file.content = Buffer.from('lgtm:\n  bind_to_commit: false\n').toString('base64')
      const status = new utils.ObserveRequest()
      const label = new utils.ObserveRequest()
      server.use(
        http.get(utils.contentsUrl('.github/prow.yaml'), utils.mockResponse(200, file)),
        ...prHandlers({}, ['src/file1.txt'], { labels: [{ name: 'lgtm' }] }),
        http.post(`${repo}/statuses/headsha`, utils.mockResponse(201, {}, status)),
        http.get(`${repo}/commits/headsha/status`, utils.mockResponse(200, { state: 'pending', statuses: [] }, status)),
        http.post(`${repo}/issues/1/labels`, utils.mockResponse(200, [], label)),
        http.put(`${repo}/pulls/1/merge`, utils.mockResponse(200, { merged: true })),
      )
      const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})

      await handleIssueComment(new utils.MockContext(prCommentEvent('/lgtm')))

      await expect(label.called()).resolves.toBe('called')
      await expect(status.notCalled()).resolves.toBe('not called')
      expect(calls.some(call => call.includes('/statuses/') || call.endsWith('/status'))).toBe(false)
      expect(setFailed).not.toHaveBeenCalled()
    })

    it('/lgtm cancel on a pull request removes the label and sets the head status to pending', async () => {
      const remove = new utils.ObserveRequest()
      const status = new utils.ObserveRequest()
      // the pull request read is the one made after the removal
      server.use(
        ...prHandlers({}, ['src/file1.txt']),
        http.get(`${repo}/issues/1`, utils.mockResponse(200, { labels: [{ name: 'lgtm' }] })),
        http.delete(`${repo}/issues/1/labels/lgtm`, utils.mockResponse(200, [], remove)),
        http.post(`${repo}/statuses/headsha`, utils.mockResponse(201, {}, status)),
      )
      const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})

      await handleIssueComment(new utils.MockContext(prCommentEvent('/lgtm cancel')))

      await expect(remove.called()).resolves.toBe('called')
      await expect(status.called()).resolves.toBe('called')
      expect(await status.body()).toEqual({ state: 'pending', context: 'prow/lgtm', description: 'lgtm cancelled by Codertocat' })
      expect(calls.indexOf('POST /repos/Codertocat/Hello-World/statuses/headsha')).toBeGreaterThan(calls.indexOf('DELETE /repos/Codertocat/Hello-World/issues/1/labels/lgtm'))
      expect(setFailed).not.toHaveBeenCalled()
    })

    it('/remove-lgtm by the author needs no reviewer check and still voids the binding', async () => {
      const status = new utils.ObserveRequest()
      const membership = new utils.ObserveRequest()
      server.use(
        http.get(`${utils.api}/orgs/Codertocat/members/Codertocat`, utils.mockResponse(204, null, membership)),
        ...prHandlers({}, ['src/file1.txt']),
        http.get(`${repo}/issues/1`, utils.mockResponse(200, { labels: [{ name: 'lgtm' }] })),
        http.delete(`${repo}/issues/1/labels/lgtm`, utils.mockResponse(200, [])),
        http.post(`${repo}/statuses/headsha`, utils.mockResponse(201, {}, status)),
      )
      const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})

      await handleIssueComment(new utils.MockContext(prCommentEvent('/remove-lgtm', 'Codertocat', 'Codertocat')))

      await expect(status.called()).resolves.toBe('called')
      await expect(membership.notCalled()).resolves.toBe('not called')
      expect(setFailed).not.toHaveBeenCalled()
    })

    it('a 403 on the cancel status still removes the label and only warns', async () => {
      const remove = new utils.ObserveRequest()
      server.use(
        ...prHandlers({}, ['src/file1.txt']),
        http.get(`${repo}/issues/1`, utils.mockResponse(200, { labels: [{ name: 'lgtm' }] })),
        http.delete(`${repo}/issues/1/labels/lgtm`, utils.mockResponse(200, [], remove)),
        http.post(`${repo}/statuses/headsha`, utils.mockResponse(403, { message: 'Resource not accessible by integration' })),
      )
      const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})
      const warning = vi.spyOn(core, 'warning').mockImplementation(() => {})

      await handleIssueComment(new utils.MockContext(prCommentEvent('/lgtm cancel')))

      await expect(remove.called()).resolves.toBe('called')
      expect(warning).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('could not set the prow/lgtm status of headsha to pending'))
      expect(setFailed).not.toHaveBeenCalled()
    })

    it('/lgtm cancel with no lgtm on the pull request touches neither label nor status', async () => {
      const status = new utils.ObserveRequest()
      const remove = new utils.ObserveRequest()
      server.use(
        ...prHandlers({}, ['src/file1.txt']),
        http.get(`${repo}/issues/1`, utils.mockResponse(200, { labels: [] })),
        http.delete(`${repo}/issues/1/labels/lgtm`, utils.mockResponse(200, [], remove)),
        http.post(`${repo}/statuses/headsha`, utils.mockResponse(201, {}, status)),
      )
      const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})

      await handleIssueComment(new utils.MockContext(prCommentEvent('/lgtm cancel')))

      await expect(remove.notCalled()).resolves.toBe('not called')
      await expect(status.notCalled()).resolves.toBe('not called')
      expect(setFailed).not.toHaveBeenCalled()
    })
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
      utils.repoHasLabels(['lgtm']),
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
