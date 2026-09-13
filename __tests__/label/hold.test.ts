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

const server = setupServer(...utils.noOrgOrRepoConfigExcept())
beforeAll(() =>
  server.listen({
    onUnhandledRequest: 'error',
  }),
)
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

const issueUrl = `${utils.api}/repos/Codertocat/Hello-World/issues/1`
const labelsUrl = `${issueUrl}/labels`
const holdLabel = 'do-not-merge/hold'
const legacyHold = 'hold'

function issueWithLabels(...names: string[]) {
  const payload = structuredClone(issuePayload)
  for (const name of names) {
    payload.labels.push({ ...payload.labels[0], name })
  }
  return payload
}

function legacyHoldConfig() {
  const file = structuredClone(labelFileContents)
  file.content = Buffer.from('hold:\n  label: hold\n').toString('base64')
  return http.get(utils.contentsUrl('.github/prow.yaml'), utils.mockResponse(200, file))
}

function observeDelete(name: string) {
  const observe = new utils.ObserveRequest()
  server.use(http.delete(`${labelsUrl}/${encodeURIComponent(name)}`, utils.mockResponse(200, null, observe)))
  return observe
}

describe('hold', () => {
  beforeEach(() => {
    utils.setupActionsEnv('/hold')
  })

  it.each(['/hold', '/HOLD'])('%s labels the issue with do-not-merge/hold', async (body) => {
    issueCommentEvent.comment.body = body
    const commentContext = new utils.MockContext(issueCommentEvent)

    const observeReq = new utils.ObserveRequest()
    server.use(
      http.post(labelsUrl, utils.mockResponse(200, null, observeReq)),
      utils.repoHasLabels([holdLabel, legacyHold]),
    )

    await handleIssueComment(commentContext)
    await observeReq.called()
    expect(await observeReq.body()).toEqual({ labels: [holdLabel] })
  })

  it('labels the issue with the configured hold.label', async () => {
    issueCommentEvent.comment.body = '/hold'
    const commentContext = new utils.MockContext(issueCommentEvent)

    const observeReq = new utils.ObserveRequest()
    server.use(
      legacyHoldConfig(),
      http.post(labelsUrl, utils.mockResponse(200, null, observeReq)),
      utils.repoHasLabels([legacyHold]),
    )

    await handleIssueComment(commentContext)
    await observeReq.called()
    expect(await observeReq.body()).toEqual({ labels: [legacyHold] })
  })

  it('fails when the repository lacks the do-not-merge/hold label', async () => {
    issueCommentEvent.comment.body = '/hold'
    const commentContext = new utils.MockContext(issueCommentEvent)

    const observeReq = new utils.ObserveRequest()
    server.use(
      http.post(labelsUrl, utils.mockResponse(200, null, observeReq)),
      utils.repoHasLabels([legacyHold]),
    )

    const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})
    await handleIssueComment(commentContext)
    await expect(observeReq.notCalled()).resolves.toBe('not called')
    expect(setFailed).toHaveBeenCalledWith(
      expect.stringContaining(`the label(s) ${holdLabel} cannot be applied because the repository doesn't have them`),
    )
  })

  describe('cancel', () => {
    it.each(['/hold cancel', '/unhold', '/remove-hold', '/UNHOLD', '/Hold Cancel'])('%s removes do-not-merge/hold and the legacy hold label', async (body) => {
      issueCommentEvent.comment.body = body
      const commentContext = new utils.MockContext(issueCommentEvent)

      const observeGet = new utils.ObserveRequest()
      const observeAdd = new utils.ObserveRequest()
      server.use(
        http.get(issueUrl, utils.mockResponse(200, issueWithLabels(legacyHold, holdLabel), observeGet)),
        http.post(labelsUrl, utils.mockResponse(200, null, observeAdd)),
        utils.repoHasLabels([holdLabel, legacyHold]),
      )
      const observeNew = observeDelete(holdLabel)
      const observeLegacy = observeDelete(legacyHold)

      const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})
      await handleIssueComment(commentContext)
      await expect(observeGet.called()).resolves.toBe('called')
      await expect(observeNew.called()).resolves.toBe('called')
      await expect(observeLegacy.called()).resolves.toBe('called')
      await expect(observeAdd.notCalled()).resolves.toBe('not called')
      expect(setFailed).not.toHaveBeenCalled()
    })

    it('removes only the legacy hold label when that is all the issue carries', async () => {
      issueCommentEvent.comment.body = '/hold cancel'
      const commentContext = new utils.MockContext(issueCommentEvent)

      server.use(http.get(issueUrl, utils.mockResponse(200, issueWithLabels(legacyHold))))
      const observeNew = observeDelete(holdLabel)
      const observeLegacy = observeDelete(legacyHold)

      await handleIssueComment(commentContext)
      await expect(observeLegacy.called()).resolves.toBe('called')
      await expect(observeNew.notCalled()).resolves.toBe('not called')
    })

    it('removes only do-not-merge/hold when the legacy label is absent', async () => {
      issueCommentEvent.comment.body = '/unhold'
      const commentContext = new utils.MockContext(issueCommentEvent)

      server.use(http.get(issueUrl, utils.mockResponse(200, issueWithLabels(holdLabel))))
      const observeNew = observeDelete(holdLabel)
      const observeLegacy = observeDelete(legacyHold)

      await handleIssueComment(commentContext)
      await expect(observeNew.called()).resolves.toBe('called')
      await expect(observeLegacy.notCalled()).resolves.toBe('not called')
    })

    it('removes the configured hold.label and the legacy hold label once when they are the same', async () => {
      issueCommentEvent.comment.body = '/hold cancel'
      const commentContext = new utils.MockContext(issueCommentEvent)

      let deletes = 0
      server.use(
        legacyHoldConfig(),
        http.get(issueUrl, utils.mockResponse(200, issueWithLabels(legacyHold))),
        http.delete(`${labelsUrl}/${legacyHold}`, () => {
          deletes++
          return new Response(null, { status: 200 })
        }),
      )

      const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})
      await handleIssueComment(commentContext)
      expect(deletes).toBe(1)
      expect(setFailed).not.toHaveBeenCalled()
    })

    it.each(['/hold cancel', '/unhold', '/remove-hold'])('does not issue a removal with %s when no hold label is present', async (body) => {
      issueCommentEvent.comment.body = body
      const commentContext = new utils.MockContext(issueCommentEvent)

      server.use(http.get(issueUrl, utils.mockResponse(200, issuePayload)))
      const observeNew = observeDelete(holdLabel)
      const observeLegacy = observeDelete(legacyHold)

      const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})
      await handleIssueComment(commentContext)
      await expect(observeNew.notCalled()).resolves.toBe('not called')
      await expect(observeLegacy.notCalled()).resolves.toBe('not called')
      expect(setFailed).not.toHaveBeenCalled()
    })

    it.each([
      ['/hold\n/hold cancel'],
      ['/hold cancel\n/hold'],
    ])('cancel wins when a comment carries both /hold and /hold cancel: %j', async (body) => {
      issueCommentEvent.comment.body = body
      const commentContext = new utils.MockContext(issueCommentEvent)

      const observeAdd = new utils.ObserveRequest()
      server.use(
        http.get(issueUrl, utils.mockResponse(200, issueWithLabels(holdLabel))),
        http.post(labelsUrl, utils.mockResponse(200, null, observeAdd)),
        utils.repoHasLabels([holdLabel]),
      )
      const observeNew = observeDelete(holdLabel)

      const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})
      await handleIssueComment(commentContext)
      await expect(observeNew.called()).resolves.toBe('called')
      await expect(observeAdd.notCalled()).resolves.toBe('not called')
      expect(setFailed).not.toHaveBeenCalled()
    })

    it('removes the hold labels when /unhold is the configured command', async () => {
      utils.setupActionsEnv('/unhold')
      issueCommentEvent.comment.body = '/unhold'
      const commentContext = new utils.MockContext(issueCommentEvent)

      server.use(http.get(issueUrl, utils.mockResponse(200, issueWithLabels(holdLabel))))
      const observeNew = observeDelete(holdLabel)

      const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})
      await handleIssueComment(commentContext)
      await expect(observeNew.called()).resolves.toBe('called')
      expect(setFailed).not.toHaveBeenCalled()
    })

    it('fails the action when the hold removal fails', async () => {
      issueCommentEvent.comment.body = '/hold cancel'
      const commentContext = new utils.MockContext(issueCommentEvent)

      server.use(
        http.get(issueUrl, utils.mockResponse(200, issueWithLabels(holdLabel))),
        http.delete(`${labelsUrl}/${encodeURIComponent(holdLabel)}`, utils.mockResponse(500)),
      )

      const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})
      await handleIssueComment(commentContext)
      expect(setFailed).toHaveBeenCalledWith(
        expect.stringContaining(`could not remove label ${holdLabel}`),
      )
    })
  })
})
