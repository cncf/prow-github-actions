import type { MockedFunction } from 'vitest'
import * as core from '@actions/core'
import * as github from '@actions/github'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { handleCronJobs } from '../src/cronJobs/handleCronJob'
import { handleIssueComment } from '../src/issueComment/handleIssueComment'
import { handlePullReq } from '../src/pullReq/handlePullReq'
import { run } from '../src/run'

vi.mock('../src/issueComment/handleIssueComment', () => ({
  handleIssueComment: vi.fn(),
}))
vi.mock('../src/pullReq/handlePullReq', () => ({
  handlePullReq: vi.fn(),
}))
vi.mock('../src/cronJobs/handleCronJob', () => ({
  handleCronJobs: vi.fn(),
}))

const mockedHandle = handleIssueComment as MockedFunction<
  typeof handleIssueComment
>
const mockedHandlePullReq = handlePullReq as MockedFunction<typeof handlePullReq>
const mockedHandleCronJobs = handleCronJobs as MockedFunction<typeof handleCronJobs>

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

  it('dispatches issue_comment to handleIssueComment', async () => {
    mockedHandle.mockResolvedValue()

    await run()

    expect(mockedHandle).toHaveBeenCalledTimes(1)
    expect(mockedHandlePullReq).not.toHaveBeenCalled()
    expect(mockedHandleCronJobs).not.toHaveBeenCalled()
  })

  it('dispatches pull_request to handlePullReq', async () => {
    github.context.eventName = 'pull_request'
    mockedHandlePullReq.mockResolvedValue()

    await run()

    expect(mockedHandlePullReq).toHaveBeenCalledTimes(1)
    expect(mockedHandle).not.toHaveBeenCalled()
    expect(mockedHandleCronJobs).not.toHaveBeenCalled()
  })

  it('dispatches schedule to handleCronJobs', async () => {
    github.context.eventName = 'schedule'
    mockedHandleCronJobs.mockResolvedValue()

    await run()

    expect(mockedHandleCronJobs).toHaveBeenCalledTimes(1)
    expect(mockedHandle).not.toHaveBeenCalled()
    expect(mockedHandlePullReq).not.toHaveBeenCalled()
  })

  it.each(['workflow_dispatch', 'push'])('dispatches %s to handleCronJobs', async (eventName) => {
    github.context.eventName = eventName
    mockedHandleCronJobs.mockResolvedValue()

    await run()

    expect(mockedHandleCronJobs).toHaveBeenCalledTimes(1)
    expect(mockedHandle).not.toHaveBeenCalled()
    expect(mockedHandlePullReq).not.toHaveBeenCalled()
  })

  it('logs an error for an unsupported event without failing', async () => {
    github.context.eventName = 'issues'
    const logError = vi.spyOn(core, 'error').mockImplementation(() => {})
    const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})

    await expect(run()).resolves.toBeUndefined()

    expect(logError).toHaveBeenCalledWith('issues not yet supported')
    expect(setFailed).not.toHaveBeenCalled()
    expect(mockedHandle).not.toHaveBeenCalled()
    expect(mockedHandlePullReq).not.toHaveBeenCalled()
    expect(mockedHandleCronJobs).not.toHaveBeenCalled()
  })

  it('reports a dispatched handler rejection through setFailed', async () => {
    mockedHandle.mockRejectedValue(new Error('handler blew up'))
    const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})

    await run()

    expect(setFailed).toHaveBeenCalledWith('handler blew up')
  })
})
