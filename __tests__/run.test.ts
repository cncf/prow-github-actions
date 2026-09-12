import type { MockedFunction } from 'vitest'
import * as core from '@actions/core'
import * as github from '@actions/github'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { handleCronJobs } from '../src/cronJobs/handleCronJob'
import { handleIssueComment } from '../src/issueComment/handleIssueComment'
import { handleIssues } from '../src/issues/handleIssues'
import { handleCheckSuite } from '../src/pullReq/handleCheckSuite'
import { handlePullReq } from '../src/pullReq/handlePullReq'
import { handlePullReqReview } from '../src/pullReq/handlePullReqReview'
import { run } from '../src/run'

vi.mock('../src/issueComment/handleIssueComment', () => ({
  handleIssueComment: vi.fn(),
}))
vi.mock('../src/issues/handleIssues', () => ({
  handleIssues: vi.fn(),
}))
vi.mock('../src/pullReq/handlePullReq', () => ({
  handlePullReq: vi.fn(),
}))
vi.mock('../src/pullReq/handlePullReqReview', () => ({
  handlePullReqReview: vi.fn(),
}))
vi.mock('../src/pullReq/handleCheckSuite', () => ({
  handleCheckSuite: vi.fn(),
}))
vi.mock('../src/cronJobs/handleCronJob', () => ({
  handleCronJobs: vi.fn(),
}))

const mockedHandle = handleIssueComment as MockedFunction<
  typeof handleIssueComment
>
const mockedHandlePullReq = handlePullReq as MockedFunction<typeof handlePullReq>
const mockedHandleCronJobs = handleCronJobs as MockedFunction<typeof handleCronJobs>

const handlers = {
  handleIssueComment: mockedHandle,
  handleIssues: handleIssues as MockedFunction<typeof handleIssues>,
  handlePullReq: mockedHandlePullReq,
  handlePullReqReview: handlePullReqReview as MockedFunction<typeof handlePullReqReview>,
  handleCheckSuite: handleCheckSuite as MockedFunction<typeof handleCheckSuite>,
  handleCronJobs: mockedHandleCronJobs,
}
type HandlerName = keyof typeof handlers

const dispatchTable: [string, HandlerName][] = [
  ['issue_comment', 'handleIssueComment'],
  ['issues', 'handleIssues'],
  ['pull_request', 'handlePullReq'],
  ['pull_request_target', 'handlePullReq'],
  ['pull_request_review', 'handlePullReqReview'],
  ['check_suite', 'handleCheckSuite'],
  ['status', 'handleCheckSuite'],
  ['schedule', 'handleCronJobs'],
  ['workflow_dispatch', 'handleCronJobs'],
  ['push', 'handleCronJobs'],
]

describe('run', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    github.context.eventName = 'issue_comment'
  })

  it('does not resolve until the dispatched handler settles', async () => {
    let releaseHandler!: () => void
    const handlerGate = new Promise<void>((resolve) => {
      releaseHandler = resolve
    })
    mockedHandle.mockReturnValue(handlerGate)

    let resolved = false
    const running = run().then(() => {
      resolved = true
    })

    await new Promise((resolve) => {
      setTimeout(resolve, 20)
    })
    expect(resolved).toBe(false)

    releaseHandler()
    await running
    expect(resolved).toBe(true)
  })

  it.each(dispatchTable)('dispatches %s to %s with the github context', async (eventName, handlerName) => {
    github.context.eventName = eventName
    handlers[handlerName].mockResolvedValue()

    await run()

    expect(handlers[handlerName]).toHaveBeenCalledTimes(1)
    expect(handlers[handlerName]).toHaveBeenCalledWith(github.context)
    for (const [name, handler] of Object.entries(handlers)) {
      if (name !== handlerName) {
        expect(handler, name).not.toHaveBeenCalled()
      }
    }
  })

  it.each(['release', 'toString', 'constructor'])('logs an error for the unsupported event %s without failing', async (eventName) => {
    github.context.eventName = eventName
    const logError = vi.spyOn(core, 'error').mockImplementation(() => {})
    const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})

    await expect(run()).resolves.toBeUndefined()

    expect(logError).toHaveBeenCalledWith(`${eventName} not yet supported`)
    expect(setFailed).not.toHaveBeenCalled()
    for (const handler of Object.values(handlers)) {
      expect(handler).not.toHaveBeenCalled()
    }
  })

  it('reports a dispatched handler rejection through setFailed', async () => {
    mockedHandle.mockRejectedValue(new Error('handler blew up'))
    const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})

    await run()

    expect(setFailed).toHaveBeenCalledWith('handler blew up')
  })
})
