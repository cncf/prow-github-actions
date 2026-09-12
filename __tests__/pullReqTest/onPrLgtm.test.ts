import * as core from '@actions/core'
import { http } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { handlePullReq } from '../../src/pullReq/handlePullReq'
import issuePayload from '../fixtures/issues/issue.json'

import pullReqOpenedEvent from '../fixtures/pullReq/pullReqOpenedEvent.json'
import * as utils from '../testUtils'

// removal is tied to new commits, so the cases below run on `synchronize`
const pullReqEvent = { ...pullReqOpenedEvent, action: 'synchronize' }

const server = setupServer()
beforeAll(() =>
  server.listen({
    onUnhandledRequest: 'error',
  }),
)
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

describe('onPrLgtm', () => {
  beforeEach(() => {
    utils.setupJobsEnv('lgtm')
  })

  it('removes the label lgtm', async () => {
    const prContext = new utils.MockContext(pullReqEvent)

    const payload = structuredClone(issuePayload)
    payload.labels.push({
      id: 1999,
      node_id: 'MEOW111=',
      url: 'https://api.github.com/repos/octocat/Hello-World/labels/lgtm',
      name: 'lgtm',
      description: 'looks good to me',
      color: 'f29513',
      default: false,
    })

    const observeReq = new utils.ObserveRequest()
    server.use(
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1`,
        utils.mockResponse(200, payload),
      ),
      http.delete(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1/labels/lgtm`,
        utils.mockResponse(200, null, observeReq),
      ),
    )

    await expect(handlePullReq(prContext)).resolves.not.toThrow()
    await expect(observeReq.called()).resolves.toBe('called')
  })

  it('does not issue a removal when lgtm is absent', async () => {
    const prContext = new utils.MockContext(pullReqEvent)

    const observeReq = new utils.ObserveRequest()
    server.use(
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1`,
        utils.mockResponse(200, issuePayload),
      ),
      http.delete(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1/labels/lgtm`,
        utils.mockResponse(200, null, observeReq),
      ),
    )

    const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})
    await expect(handlePullReq(prContext)).resolves.not.toThrow()
    await expect(observeReq.notCalled()).resolves.toBe('not called')
    expect(setFailed).not.toHaveBeenCalled()
  })

  it.each(['opened', 'labeled', 'unlabeled'])('leaves lgtm in place on a %s action', async (action) => {
    const prContext = new utils.MockContext({ ...pullReqOpenedEvent, action })

    const payload = structuredClone(issuePayload)
    payload.labels.push({ ...payload.labels[0], name: 'lgtm' })

    const observeReq = new utils.ObserveRequest()
    server.use(
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1`,
        utils.mockResponse(200, payload),
      ),
      http.delete(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1/labels/lgtm`,
        utils.mockResponse(200, null, observeReq),
      ),
    )

    const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})
    await expect(handlePullReq(prContext)).resolves.not.toThrow()
    await expect(observeReq.notCalled()).resolves.toBe('not called')
    expect(setFailed).not.toHaveBeenCalled()
  })
})
