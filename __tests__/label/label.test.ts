import { Buffer } from 'node:buffer'
import * as core from '@actions/core'
import { http } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { handleIssueComment } from '../../src/issueComment/handleIssueComment'
import { isProtectedLabel } from '../../src/labels/prefixed'
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

function issueWithLabels(...names: string[]) {
  const payload = structuredClone(issuePayload)
  for (const name of names) {
    payload.labels.push({ ...payload.labels[0], name })
  }
  return payload
}

// a repo that lists the protected labels under `labels:` is not itself an error
const withProtected = structuredClone(labelFileContents)
withProtected.content = Buffer.from(
  'labels:\n  - documentation\n  - lgtm\n  - hold\n  - approved\n  - do-not-merge/work-in-progress\n',
).toString('base64')

describe('isProtectedLabel', () => {
  it.each(['lgtm', 'hold', 'approved', 'LGTM', 'Hold', 'do-not-merge/work-in-progress', 'DO-NOT-MERGE/hold'])(
    'protects %s',
    (label) => {
      expect(isProtectedLabel(label)).toBe(true)
    },
  )

  it.each(['documentation', 'kind/lgtm', 'lgtm-please', 'do-not-merge', 'holdover'])(
    'does not protect %s',
    (label) => {
      expect(isProtectedLabel(label)).toBe(false)
    },
  )
})

describe('protected labels', () => {
  beforeEach(() => {
    utils.setupActionsEnv('/label')
  })

  it.each(['/label lgtm', '/label do-not-merge/work-in-progress', '/label documentation lgtm'])(
    'refuses "%s" without adding any label',
    async (body) => {
      issueCommentEvent.comment.body = body
      const commentContext = new utils.MockContext(issueCommentEvent)

      const observePost = new utils.ObserveRequest()
      server.use(
        http.post(
          `${utils.api}/repos/Codertocat/Hello-World/issues/1/labels`,
          utils.mockResponse(200, null, observePost),
        ),
        utils.repoHasLabels(['good-first-issue', 'help-wanted', 'documentation', 'tide/merge-method-squash']),
        http.get(
          `${utils.api}/repos/Codertocat/Hello-World/contents/.prowlabels.yaml`,
          utils.mockResponse(200, withProtected),
        ),
        ...utils.noOrgOrRepoConfigExcept('.prowlabels.yaml'),
      )

      const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})
      await handleIssueComment(commentContext)
      await expect(observePost.notCalled()).resolves.toBe('not called')
      expect(setFailed).toHaveBeenCalledTimes(1)
      expect(setFailed).toHaveBeenCalledWith(
        expect.stringContaining('managed by its own command and cannot be changed with /label'),
      )
    },
  )

  it.each([
    ['/remove-label hold', 'hold'],
    ['/remove-label LGTM', 'lgtm'],
  ])('refuses "%s" without removing any label', async (body, onIssue) => {
    issueCommentEvent.comment.body = body
    const commentContext = new utils.MockContext(issueCommentEvent)

    const observeDelete = new utils.ObserveRequest()
    server.use(
      http.delete(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1/labels/${onIssue}`,
        utils.mockResponse(200, null, observeDelete),
      ),
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1`,
        utils.mockResponse(200, issueWithLabels(onIssue)),
      ),
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/contents/.prowlabels.yaml`,
        utils.mockResponse(200, withProtected),
      ),
      ...utils.noOrgOrRepoConfigExcept('.prowlabels.yaml'),
    )

    const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})
    await handleIssueComment(commentContext)
    await expect(observeDelete.notCalled()).resolves.toBe('not called')
    expect(setFailed).toHaveBeenCalledWith(
      expect.stringContaining(`remove-label: ${onIssue} is managed by its own command and cannot be changed with /remove-label`),
    )
  })

  it('still adds a plain label listed next to protected ones', async () => {
    issueCommentEvent.comment.body = '/label documentation'
    const commentContext = new utils.MockContext(issueCommentEvent)

    const observePost = new utils.ObserveRequest()
    server.use(
      http.post(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1/labels`,
        utils.mockResponse(200, null, observePost),
      ),
      utils.repoHasLabels(['good-first-issue', 'help-wanted', 'documentation', 'tide/merge-method-squash']),
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/contents/.prowlabels.yaml`,
        utils.mockResponse(200, withProtected),
      ),
      ...utils.noOrgOrRepoConfigExcept('.prowlabels.yaml'),
    )

    const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})
    await handleIssueComment(commentContext)
    await observePost.called()
    expect(await observePost.body()).toEqual({ labels: ['documentation'] })
    expect(setFailed).not.toHaveBeenCalled()
  })
})

describe('label', () => {
  beforeEach(() => {
    utils.setupActionsEnv('/label')
  })

  it('labels the issue with an allowlisted label as-is', async () => {
    issueCommentEvent.comment.body = '/label good-first-issue'
    const commentContext = new utils.MockContext(issueCommentEvent)

    const observeReq = new utils.ObserveRequest()
    server.use(
      http.post(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1/labels`,
        utils.mockResponse(200, null, observeReq),
      ),
      utils.repoHasLabels(['good-first-issue', 'help-wanted', 'documentation', 'tide/merge-method-squash']),
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/contents/.prowlabels.yaml`,
        utils.mockResponse(200, labelFileContents),
      ),
      ...utils.noOrgOrRepoConfigExcept('.prowlabels.yaml'),
    )

    await handleIssueComment(commentContext)
    await observeReq.called()
    expect(await observeReq.body()).toMatchObject({
      labels: ['good-first-issue'],
    })
  })

  it('handles multiple labels and drops values not in .prowlabels.yaml', async () => {
    issueCommentEvent.comment.body = '/label good-first-issue lgtm help-wanted'
    const commentContext = new utils.MockContext(issueCommentEvent)

    const observeReq = new utils.ObserveRequest()
    server.use(
      http.post(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1/labels`,
        utils.mockResponse(200, null, observeReq),
      ),
      utils.repoHasLabels(['good-first-issue', 'help-wanted', 'documentation', 'tide/merge-method-squash']),
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/contents/.prowlabels.yaml`,
        utils.mockResponse(200, labelFileContents),
      ),
      ...utils.noOrgOrRepoConfigExcept('.prowlabels.yaml'),
    )

    await handleIssueComment(commentContext)
    await observeReq.called()
    expect(await observeReq.body()).toMatchObject({
      labels: ['good-first-issue', 'help-wanted'],
    })
  })

  it('fails when no label argument is in .prowlabels.yaml', async () => {
    issueCommentEvent.comment.body = '/label lgtm'
    const commentContext = new utils.MockContext(issueCommentEvent)

    const observeReq = new utils.ObserveRequest()
    server.use(
      http.post(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1/labels`,
        utils.mockResponse(200, null, observeReq),
      ),
      utils.repoHasLabels(['good-first-issue', 'help-wanted', 'documentation', 'tide/merge-method-squash']),
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
      expect.stringContaining('label: command args missing from body'),
    )
  })

  it('fails when .prowlabels.yaml has no labels key', async () => {
    issueCommentEvent.comment.body = '/label good-first-issue'
    const commentContext = new utils.MockContext(issueCommentEvent)

    const withoutLabels = structuredClone(labelFileContents)
    withoutLabels.content = Buffer.from('kind:\n  - cleanup\n').toString('base64')

    const observeReq = new utils.ObserveRequest()
    server.use(
      http.post(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1/labels`,
        utils.mockResponse(200, null, observeReq),
      ),
      utils.repoHasLabels(['good-first-issue', 'help-wanted', 'documentation', 'tide/merge-method-squash']),
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/contents/.prowlabels.yaml`,
        utils.mockResponse(200, withoutLabels),
      ),
      ...utils.noOrgOrRepoConfigExcept('.prowlabels.yaml'),
    )

    const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})
    await handleIssueComment(commentContext)
    await expect(observeReq.notCalled()).resolves.toBe('not called')
    expect(setFailed).toHaveBeenCalledWith(
      expect.stringContaining(`labels: yaml malformed, expected 'labels' top level key`),
    )
  })

  it('removes an allowlisted label with /remove-label', async () => {
    issueCommentEvent.comment.body = '/remove-label help-wanted'
    const commentContext = new utils.MockContext(issueCommentEvent)

    const observeDelete = new utils.ObserveRequest()
    const observePost = new utils.ObserveRequest()
    server.use(
      http.delete(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1/labels/help-wanted`,
        utils.mockResponse(200, null, observeDelete),
      ),
      http.post(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1/labels`,
        utils.mockResponse(200, null, observePost),
      ),
      utils.repoHasLabels(['good-first-issue', 'help-wanted', 'documentation', 'tide/merge-method-squash']),
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1`,
        utils.mockResponse(200, issueWithLabels('help-wanted')),
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

  it('refuses /remove-label for a label not in .prowlabels.yaml', async () => {
    issueCommentEvent.comment.body = '/remove-label lgtm'
    const commentContext = new utils.MockContext(issueCommentEvent)

    const observeDelete = new utils.ObserveRequest()
    server.use(
      http.delete(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1/labels/lgtm`,
        utils.mockResponse(200, null, observeDelete),
      ),
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1`,
        utils.mockResponse(200, issueWithLabels('lgtm')),
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
      expect.stringContaining('remove-label: command args missing from body'),
    )
  })

  it('does not call the api when the label is not on the issue', async () => {
    issueCommentEvent.comment.body = '/remove-label help-wanted'
    const commentContext = new utils.MockContext(issueCommentEvent)

    const observeDelete = new utils.ObserveRequest()
    server.use(
      http.delete(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1/labels/help-wanted`,
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

  it('adds an allowlisted label containing a slash verbatim', async () => {
    issueCommentEvent.comment.body = '/label tide/merge-method-squash'
    const commentContext = new utils.MockContext(issueCommentEvent)

    const withSlash = structuredClone(labelFileContents)
    withSlash.content = Buffer.from('labels:\n  - tide/merge-method-squash\n').toString('base64')

    const observeReq = new utils.ObserveRequest()
    server.use(
      http.post(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1/labels`,
        utils.mockResponse(200, null, observeReq),
      ),
      utils.repoHasLabels(['good-first-issue', 'help-wanted', 'documentation', 'tide/merge-method-squash']),
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/contents/.prowlabels.yaml`,
        utils.mockResponse(200, withSlash),
      ),
      ...utils.noOrgOrRepoConfigExcept('.prowlabels.yaml'),
    )

    const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})
    await handleIssueComment(commentContext)
    await observeReq.called()
    expect(await observeReq.body()).toEqual({
      labels: ['tide/merge-method-squash'],
    })
    expect(setFailed).not.toHaveBeenCalled()
  })

  it('removes an allowlisted label containing a slash with /remove-label', async () => {
    issueCommentEvent.comment.body = '/remove-label tide/merge-method-squash'
    const commentContext = new utils.MockContext(issueCommentEvent)

    const withSlash = structuredClone(labelFileContents)
    withSlash.content = Buffer.from('labels:\n  - tide/merge-method-squash\n').toString('base64')

    const observeDelete = new utils.ObserveRequest()
    const observePost = new utils.ObserveRequest()
    server.use(
      http.delete(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1/labels/tide%2Fmerge-method-squash`,
        utils.mockResponse(200, null, observeDelete),
      ),
      http.post(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1/labels`,
        utils.mockResponse(200, null, observePost),
      ),
      utils.repoHasLabels(['good-first-issue', 'help-wanted', 'documentation', 'tide/merge-method-squash']),
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1`,
        utils.mockResponse(200, issueWithLabels('tide/merge-method-squash')),
      ),
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/contents/.prowlabels.yaml`,
        utils.mockResponse(200, withSlash),
      ),
      ...utils.noOrgOrRepoConfigExcept('.prowlabels.yaml'),
    )

    const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})
    await handleIssueComment(commentContext)
    await expect(observeDelete.called()).resolves.toBe('called')
    await expect(observePost.notCalled()).resolves.toBe('not called')
    expect(setFailed).not.toHaveBeenCalled()
  })

  it('handles /label and /remove-label in the same comment', async () => {
    issueCommentEvent.comment.body = '/label good-first-issue\n/remove-label help-wanted'
    const commentContext = new utils.MockContext(issueCommentEvent)

    const observeDelete = new utils.ObserveRequest()
    const observePost = new utils.ObserveRequest()
    server.use(
      http.delete(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1/labels/help-wanted`,
        utils.mockResponse(200, null, observeDelete),
      ),
      http.post(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1/labels`,
        utils.mockResponse(200, null, observePost),
      ),
      utils.repoHasLabels(['good-first-issue', 'help-wanted', 'documentation', 'tide/merge-method-squash']),
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1`,
        utils.mockResponse(200, issueWithLabels('help-wanted')),
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
      labels: ['good-first-issue'],
    })
    expect(setFailed).not.toHaveBeenCalled()
  })
})
