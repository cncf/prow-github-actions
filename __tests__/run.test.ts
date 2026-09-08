import type { MockedFunction } from 'vitest'
import * as core from '@actions/core'
import * as github from '@actions/github'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { handleIssueComment } from '../src/issueComment/handleIssueComment'
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

describe('run', () => {
  beforeEach(() => {
    vi.resetAllMocks()
    github.context.eventName = 'issue_comment'
  })

  afterEach(() => vi.restoreAllMocks())

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

  it('reports a dispatched handler rejection through setFailed', async () => {
    mockedHandle.mockRejectedValue(new Error('handler blew up'))
    const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})

    await run()

    expect(setFailed).toHaveBeenCalledWith('handler blew up')
  })
})
