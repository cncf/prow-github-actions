import * as core from '@actions/core'
import * as github from '@actions/github'

import { handleIssueComment } from '../src/issueComment/handleIssueComment'
import { run } from '../src/run'

jest.mock('../src/issueComment/handleIssueComment', () => ({
  handleIssueComment: jest.fn(),
}))
jest.mock('../src/pullReq/handlePullReq', () => ({
  handlePullReq: jest.fn(),
}))
jest.mock('../src/cronJobs/handleCronJob', () => ({
  handleCronJobs: jest.fn(),
}))

const mockedHandle = handleIssueComment as jest.MockedFunction<
  typeof handleIssueComment
>

describe('run', () => {
  beforeEach(() => {
    jest.resetAllMocks()
    github.context.eventName = 'issue_comment'
  })

  afterEach(() => jest.restoreAllMocks())

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
    const setFailed = jest.spyOn(core, 'setFailed').mockImplementation(() => {})

    await run()

    expect(setFailed).toHaveBeenCalledWith('handler blew up')
  })
})
