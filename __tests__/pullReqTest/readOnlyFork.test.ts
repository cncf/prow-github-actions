import * as core from '@actions/core'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { handlePullReq, pullRequestHandlers } from '../../src/pullReq/handlePullReq'
import { handlePullReqReview, pullRequestReviewHandlers } from '../../src/pullReq/handlePullReqReview'
import { skipReadOnlyForkRun } from '../../src/utils/events'
import pullReqOpenedEvent from '../fixtures/pullReq/pullReqOpenedEvent.json'
import reviewSubmittedEvent from '../fixtures/pullReq/pullReqReviewSubmittedEvent.json'
import * as utils from '../testUtils'

// no handler is served: any api call is an unhandled request and fails the test
const server = setupServer()
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))

const fork = 'octocat/Hello-World'
const same = pullReqOpenedEvent.repository.full_name

function pullRequestContext(eventName: string, headRepo: string, action = 'labeled') {
  const context = new utils.MockContext({
    ...pullReqOpenedEvent,
    action,
    label: { name: 'lgtm' },
    pull_request: { ...pullReqOpenedEvent.pull_request, head: { ...pullReqOpenedEvent.pull_request.head, repo: { ...pullReqOpenedEvent.pull_request.head.repo, full_name: headRepo } } },
  })
  context.eventName = eventName
  return context
}

function reviewContext(headRepo: string) {
  const context = new utils.MockContext({
    ...reviewSubmittedEvent,
    pull_request: { ...reviewSubmittedEvent.pull_request, head: { ...reviewSubmittedEvent.pull_request.head, repo: { full_name: headRepo } } },
  })
  context.eventName = 'pull_request_review'
  return context
}

let notice: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  utils.setupJobsEnv('lgtm')
  notice = vi.spyOn(core, 'notice').mockImplementation(() => {})
})
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

describe('skipReadOnlyForkRun', () => {
  it.each([
    ['pull_request', fork, true],
    ['pull_request', same, false],
    ['pull_request_target', fork, false],
    ['pull_request_target', same, false],
    ['pull_request_review', fork, true],
    ['pull_request_review', same, false],
  ])('%s from %s: skipped %s', (eventName, headRepo, skipped) => {
    expect(skipReadOnlyForkRun(pullRequestContext(eventName, headRepo))).toBe(skipped)
    expect(notice).toHaveBeenCalledTimes(skipped ? 1 : 0)
  })

  it('compares the repositories case-insensitively', () => {
    expect(skipReadOnlyForkRun(pullRequestContext('pull_request', same.toUpperCase()))).toBe(false)
  })

  it('a payload without head.repo (a review fixture) is not a fork', () => {
    const context = new utils.MockContext(reviewSubmittedEvent)
    context.eventName = 'pull_request_review'
    expect(skipReadOnlyForkRun(context)).toBe(false)
  })
})

describe('handlePullReq', () => {
  const registered = [...pullRequestHandlers]
  beforeEach(() => {
    pullRequestHandlers.length = 0
  })
  afterEach(() => {
    pullRequestHandlers.push(...registered)
  })

  it('pull_request for a fork: notice, no handler, no job, no api call', async () => {
    const handler = vi.fn().mockResolvedValue(undefined)
    pullRequestHandlers.push(handler)
    const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})

    await expect(handlePullReq(pullRequestContext('pull_request', fork, 'synchronize'))).resolves.toBeUndefined()

    expect(handler).not.toHaveBeenCalled()
    expect(notice).toHaveBeenCalledExactlyOnceWith('fork pull request under pull_request: the token is read-only; the sweep job handles it')
    expect(setFailed).not.toHaveBeenCalled()
  })

  it.each([
    ['pull_request', same],
    ['pull_request_target', fork],
    ['pull_request_target', same],
  ])('%s from %s runs the handlers', async (eventName, headRepo) => {
    const handler = vi.fn().mockResolvedValue(undefined)
    pullRequestHandlers.push(handler)
    utils.setupActionsEnv()

    await expect(handlePullReq(pullRequestContext(eventName, headRepo))).resolves.toBeUndefined()

    expect(handler).toHaveBeenCalledTimes(1)
    expect(notice).not.toHaveBeenCalled()
  })
})

describe('handlePullReqReview', () => {
  const registered = [...pullRequestReviewHandlers]
  beforeEach(() => {
    pullRequestReviewHandlers.length = 0
  })
  afterEach(() => {
    pullRequestReviewHandlers.push(...registered)
  })

  it('pull_request_review for a fork: notice, no handler, no api call', async () => {
    const handler = vi.fn().mockResolvedValue(undefined)
    pullRequestReviewHandlers.push(handler)

    await expect(handlePullReqReview(reviewContext(fork))).resolves.toBeUndefined()

    expect(handler).not.toHaveBeenCalled()
    expect(notice).toHaveBeenCalledExactlyOnceWith('fork pull request under pull_request_review: the token is read-only; the sweep job handles it')
  })

  it('pull_request_review from the same repository runs the handlers', async () => {
    const handler = vi.fn().mockResolvedValue(undefined)
    pullRequestReviewHandlers.push(handler)

    await expect(handlePullReqReview(reviewContext(same))).resolves.toBeUndefined()

    expect(handler).toHaveBeenCalledTimes(1)
    expect(notice).not.toHaveBeenCalled()
  })
})
