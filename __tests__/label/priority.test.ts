import * as core from '@actions/core'
import { http } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { handleIssueComment } from '../../src/issueComment/handleIssueComment'
import issuePayload from '../fixtures/issues/issue.json'
import issueCommentEvent from '../fixtures/issues/issueCommentEvent.json'

import labelFileContents from '../fixtures/labels/labelFileContentsResp.json'
import * as utils from '../testUtils'

const server = setupServer()
beforeAll(() =>
  server.listen({
    onUnhandledRequest: 'error',
  }),
)
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

describe('priority', () => {
  beforeEach(() => {
    utils.setupActionsEnv('/priority')
  })

  it('labels the issue with the priority label', async () => {
    issueCommentEvent.comment.body = '/priority low'
    const commentContext = new utils.MockContext(issueCommentEvent)

    const observeReq = new utils.ObserveRequest()
    server.use(
      http.post(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1/labels`,
        utils.mockResponse(200, null, observeReq),
      ),
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1`,
        utils.mockResponse(200, issuePayload),
      ),
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/contents/.prowlabels.yaml`,
        utils.mockResponse(200, labelFileContents),
      ),
      ...utils.noOrgOrRepoConfigExcept('.prowlabels.yaml'),
    )

    await handleIssueComment(commentContext)
    await observeReq.called()
    expect(await observeReq.body()).toMatchObject({
      labels: ['priority/low'],
    })
  })

  it('handles multiple priority labels', async () => {
    issueCommentEvent.comment.body = '/priority low high'
    const commentContext = new utils.MockContext(issueCommentEvent)

    const observeReq = new utils.ObserveRequest()
    server.use(
      http.post(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1/labels`,
        utils.mockResponse(200, null, observeReq),
      ),
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1`,
        utils.mockResponse(200, issuePayload),
      ),
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/contents/.prowlabels.yaml`,
        utils.mockResponse(200, labelFileContents),
      ),
      ...utils.noOrgOrRepoConfigExcept('.prowlabels.yaml'),
    )

    await handleIssueComment(commentContext)
    await observeReq.called()
    expect(await observeReq.body()).toMatchObject({
      labels: ['priority/low', 'priority/high'],
    })
  })

  it('only adds priority labels for files in .prowlabels.yaml', async () => {
    issueCommentEvent.comment.body = '/priority low mid high'
    const commentContext = new utils.MockContext(issueCommentEvent)

    const observeReq = new utils.ObserveRequest()
    server.use(
      http.post(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1/labels`,
        utils.mockResponse(200, null, observeReq),
      ),
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1`,
        utils.mockResponse(200, issuePayload),
      ),
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/contents/.prowlabels.yaml`,
        utils.mockResponse(200, labelFileContents),
      ),
      ...utils.noOrgOrRepoConfigExcept('.prowlabels.yaml'),
    )

    await handleIssueComment(commentContext)
    await observeReq.called()
    expect(await observeReq.body()).toMatchObject({
      labels: ['priority/low', 'priority/high'],
    })
  })

  it('replaces an existing priority label with the new one', async () => {
    issueCommentEvent.comment.body = '/priority high'
    const commentContext = new utils.MockContext(issueCommentEvent)

    const payload = structuredClone(issuePayload)
    payload.labels.push({
      id: 3,
      node_id: '789',
      url: 'https://api.github.com/repos/octocat/Hello-World/labels/priority/low',
      name: 'priority/low',
      description: '',
      color: 'f29513',
      default: true,
    })

    const observeReqDelete = new utils.ObserveRequest()
    const observeReqPost = new utils.ObserveRequest()
    server.use(
      http.delete(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1/labels/priority%2Flow`,
        utils.mockResponse(200, null, observeReqDelete),
      ),
      http.post(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1/labels`,
        utils.mockResponse(200, null, observeReqPost),
      ),
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1`,
        utils.mockResponse(200, payload),
      ),
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/contents/.prowlabels.yaml`,
        utils.mockResponse(200, labelFileContents),
      ),
      ...utils.noOrgOrRepoConfigExcept('.prowlabels.yaml'),
    )

    await handleIssueComment(commentContext)
    await expect(observeReqDelete.called()).resolves.toBe('called')
    await observeReqPost.called()
    expect(await observeReqPost.body()).toMatchObject({
      labels: ['priority/high'],
    })
  })

  it('does not remove a priority label that is already the requested one', async () => {
    issueCommentEvent.comment.body = '/priority high'
    const commentContext = new utils.MockContext(issueCommentEvent)

    const payload = structuredClone(issuePayload)
    payload.labels.push({
      id: 3,
      node_id: '789',
      url: 'https://api.github.com/repos/octocat/Hello-World/labels/priority/high',
      name: 'priority/high',
      description: '',
      color: 'f29513',
      default: true,
    })

    const observeReqDelete = new utils.ObserveRequest()
    const observeReqPost = new utils.ObserveRequest()
    server.use(
      http.delete(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1/labels/priority%2Fhigh`,
        utils.mockResponse(200, null, observeReqDelete),
      ),
      http.post(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1/labels`,
        utils.mockResponse(200, null, observeReqPost),
      ),
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1`,
        utils.mockResponse(200, payload),
      ),
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/contents/.prowlabels.yaml`,
        utils.mockResponse(200, labelFileContents),
      ),
      ...utils.noOrgOrRepoConfigExcept('.prowlabels.yaml'),
    )

    await handleIssueComment(commentContext)
    await expect(observeReqDelete.notCalled()).resolves.toBe('not called')
    await observeReqPost.called()
    expect(await observeReqPost.body()).toMatchObject({
      labels: ['priority/high'],
    })
  })

  it('fails the action when the stale priority removal fails', async () => {
    issueCommentEvent.comment.body = '/priority high'
    const commentContext = new utils.MockContext(issueCommentEvent)

    const payload = structuredClone(issuePayload)
    payload.labels.push({
      id: 3,
      node_id: '789',
      url: 'https://api.github.com/repos/octocat/Hello-World/labels/priority/low',
      name: 'priority/low',
      description: '',
      color: 'f29513',
      default: true,
    })

    server.use(
      http.delete(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1/labels/priority%2Flow`,
        utils.mockResponse(500),
      ),
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1`,
        utils.mockResponse(200, payload),
      ),
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/contents/.prowlabels.yaml`,
        utils.mockResponse(200, labelFileContents),
      ),
      ...utils.noOrgOrRepoConfigExcept('.prowlabels.yaml'),
    )

    const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})
    await handleIssueComment(commentContext)
    expect(setFailed).toHaveBeenCalledWith(
      expect.stringContaining('could not remove label priority/low'),
    )
  })

  it('fails when no priority argument is in .prowlabels.yaml', async () => {
    issueCommentEvent.comment.body = '/priority not-a-real-label'
    const commentContext = new utils.MockContext(issueCommentEvent)

    const observeReq = new utils.ObserveRequest()
    server.use(
      http.post(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1/labels`,
        utils.mockResponse(200, null, observeReq),
      ),
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/contents/.prowlabels.yaml`,
        utils.mockResponse(200, labelFileContents),
      ),
      ...utils.noOrgOrRepoConfigExcept('.prowlabels.yaml'),
    )

    const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})
    await handleIssueComment(commentContext)
    await expect(observeReq.notCalled()).resolves.toBe('not called')
    expect(setFailed).toHaveBeenCalledWith(
      expect.stringContaining('priority: command args missing from body'),
    )
  })

  it('removes a priority label with /remove-priority', async () => {
    issueCommentEvent.comment.body = '/remove-priority low'
    const commentContext = new utils.MockContext(issueCommentEvent)

    const payload = structuredClone(issuePayload)
    payload.labels.push({ ...payload.labels[0], name: 'priority/low' })

    const observeDelete = new utils.ObserveRequest()
    const observePost = new utils.ObserveRequest()
    server.use(
      http.delete(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1/labels/priority%2Flow`,
        utils.mockResponse(200, null, observeDelete),
      ),
      http.post(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1/labels`,
        utils.mockResponse(200, null, observePost),
      ),
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1`,
        utils.mockResponse(200, payload),
      ),
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/contents/.prowlabels.yaml`,
        utils.mockResponse(200, labelFileContents),
      ),
      ...utils.noOrgOrRepoConfigExcept('.prowlabels.yaml'),
    )

    const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})
    await handleIssueComment(commentContext)
    await expect(observeDelete.called()).resolves.toBe('called')
    await expect(observePost.notCalled()).resolves.toBe('not called')
    expect(setFailed).not.toHaveBeenCalled()
  })

  it('fails /remove-priority for a value not in .prowlabels.yaml', async () => {
    issueCommentEvent.comment.body = '/remove-priority mid'
    const commentContext = new utils.MockContext(issueCommentEvent)

    const payload = structuredClone(issuePayload)
    payload.labels.push({ ...payload.labels[0], name: 'priority/mid' })

    const observeDelete = new utils.ObserveRequest()
    server.use(
      http.delete(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1/labels/priority%2Fmid`,
        utils.mockResponse(200, null, observeDelete),
      ),
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1`,
        utils.mockResponse(200, payload),
      ),
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/contents/.prowlabels.yaml`,
        utils.mockResponse(200, labelFileContents),
      ),
      ...utils.noOrgOrRepoConfigExcept('.prowlabels.yaml'),
    )

    const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})
    await handleIssueComment(commentContext)
    await expect(observeDelete.notCalled()).resolves.toBe('not called')
    expect(setFailed).toHaveBeenCalledWith(
      expect.stringContaining('remove-priority: command args missing from body'),
    )
  })

  it('does not call the api when the priority label is not on the issue', async () => {
    issueCommentEvent.comment.body = '/remove-priority low'
    const commentContext = new utils.MockContext(issueCommentEvent)

    const observeDelete = new utils.ObserveRequest()
    server.use(
      http.delete(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1/labels/priority%2Flow`,
        utils.mockResponse(200, null, observeDelete),
      ),
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1`,
        utils.mockResponse(200, issuePayload),
      ),
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/contents/.prowlabels.yaml`,
        utils.mockResponse(200, labelFileContents),
      ),
      ...utils.noOrgOrRepoConfigExcept('.prowlabels.yaml'),
    )

    const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})
    await handleIssueComment(commentContext)
    await expect(observeDelete.notCalled()).resolves.toBe('not called')
    expect(setFailed).not.toHaveBeenCalled()
  })

  it('handles /priority and /remove-priority in the same comment', async () => {
    issueCommentEvent.comment.body = '/priority high\n/remove-priority low'
    const commentContext = new utils.MockContext(issueCommentEvent)

    const payload = structuredClone(issuePayload)
    payload.labels.push({ ...payload.labels[0], name: 'priority/low' })

    const observeDelete = new utils.ObserveRequest()
    const observePost = new utils.ObserveRequest()
    server.use(
      http.delete(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1/labels/priority%2Flow`,
        utils.mockResponse(200, null, observeDelete),
      ),
      http.post(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1/labels`,
        utils.mockResponse(200, null, observePost),
      ),
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1`,
        utils.mockResponse(200, payload),
      ),
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/contents/.prowlabels.yaml`,
        utils.mockResponse(200, labelFileContents),
      ),
      ...utils.noOrgOrRepoConfigExcept('.prowlabels.yaml'),
    )

    const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})
    await handleIssueComment(commentContext)
    await expect(observeDelete.called()).resolves.toBe('called')
    await observePost.called()
    expect(await observePost.body()).toMatchObject({
      labels: ['priority/high'],
    })
    expect(setFailed).not.toHaveBeenCalled()
  })

  it('removes then re-adds when /priority high low and /remove-priority high share a comment', async () => {
    issueCommentEvent.comment.body = '/priority high low\n/remove-priority high'
    const commentContext = new utils.MockContext(issueCommentEvent)

    const payload = structuredClone(issuePayload)
    payload.labels.push({ ...payload.labels[0], name: 'priority/high' })

    const mutations: string[] = []
    server.use(
      http.delete(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1/labels/:name`,
        async ({ request }) => {
          mutations.push(`DELETE ${new URL(request.url).pathname.split('/labels/')[1]}`)
          return new Response(null, { status: 200 })
        },
      ),
      http.post(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1/labels`,
        async ({ request }) => {
          const body = await request.json() as { labels: string[] }
          mutations.push(`POST ${body.labels.join(',')}`)
          return new Response(null, { status: 200 })
        },
      ),
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1`,
        utils.mockResponse(200, payload),
      ),
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/contents/.prowlabels.yaml`,
        utils.mockResponse(200, labelFileContents),
      ),
      ...utils.noOrgOrRepoConfigExcept('.prowlabels.yaml'),
    )

    const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})
    await handleIssueComment(commentContext)
    expect(mutations).toEqual([
      'DELETE priority%2Fhigh',
      'POST priority/high,priority/low',
    ])
    expect(setFailed).not.toHaveBeenCalled()
  })
})
