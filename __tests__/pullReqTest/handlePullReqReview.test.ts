import * as core from '@actions/core'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { handlePullReqReview, pullRequestReviewHandlers } from '../../src/pullReq/handlePullReqReview'
import reviewSubmittedEvent from '../fixtures/pullReq/pullReqReviewSubmittedEvent.json'
import * as utils from '../testUtils'

const server = setupServer()
beforeAll(() =>
  server.listen({
    onUnhandledRequest: 'error',
  }),
)
afterEach(() => {
  server.resetHandlers()
  pullRequestReviewHandlers.length = 0
})
afterAll(() => server.close())

describe('handlePullReqReview', () => {
  beforeEach(() => {
    utils.setupActionsEnv()
  })

  it('resolves without calling the api or failing when no handlers are registered', async () => {
    const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})
    const debug = vi.spyOn(core, 'debug').mockImplementation(() => {})

    await expect(handlePullReqReview(new utils.MockContext(reviewSubmittedEvent))).resolves.toBeUndefined()

    expect(setFailed).not.toHaveBeenCalled()
    expect(debug).toHaveBeenCalledWith('pull_request_review event submitted received; no handlers registered yet')
  })

  it('runs every registered handler with the context', async () => {
    const first = vi.fn().mockResolvedValue(undefined)
    const second = vi.fn().mockResolvedValue(undefined)
    pullRequestReviewHandlers.push(first, second)
    const context = new utils.MockContext(reviewSubmittedEvent)
    const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})

    await handlePullReqReview(context)

    expect(first).toHaveBeenCalledWith(context)
    expect(second).toHaveBeenCalledWith(context)
    expect(setFailed).not.toHaveBeenCalled()
  })

  it('fails once with the aggregated rejection message', async () => {
    pullRequestReviewHandlers.push(vi.fn().mockRejectedValue(new Error('review boom')))
    const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})

    await expect(handlePullReqReview(new utils.MockContext(reviewSubmittedEvent))).resolves.toBeUndefined()

    expect(setFailed).toHaveBeenCalledTimes(1)
    expect(setFailed).toHaveBeenCalledWith('error handling pull_request_review event: review boom')
  })
})
