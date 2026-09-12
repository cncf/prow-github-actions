import * as core from '@actions/core'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { handleIssues, issueEventHandlers } from '../../src/issues/handleIssues'
import issuesLabeledEvent from '../fixtures/issues/issuesLabeledEvent.json'
import * as utils from '../testUtils'

const server = setupServer()
beforeAll(() =>
  server.listen({
    onUnhandledRequest: 'error',
  }),
)
afterEach(() => {
  server.resetHandlers()
  issueEventHandlers.length = 0
})
afterAll(() => server.close())

describe('handleIssues', () => {
  beforeEach(() => {
    utils.setupActionsEnv()
  })

  it('resolves without calling the api or failing when no handlers are registered', async () => {
    const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})
    const debug = vi.spyOn(core, 'debug').mockImplementation(() => {})

    await expect(handleIssues(new utils.MockContext(issuesLabeledEvent))).resolves.toBeUndefined()

    expect(setFailed).not.toHaveBeenCalled()
    expect(debug).toHaveBeenCalledWith('issues event labeled received; no handlers registered yet')
  })

  it('runs every registered handler with the context', async () => {
    const first = vi.fn().mockResolvedValue(undefined)
    const second = vi.fn().mockResolvedValue(undefined)
    issueEventHandlers.push(first, second)
    const context = new utils.MockContext(issuesLabeledEvent)
    const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})

    await handleIssues(context)

    expect(first).toHaveBeenCalledWith(context)
    expect(second).toHaveBeenCalledWith(context)
    expect(setFailed).not.toHaveBeenCalled()
  })

  it('fails once with every rejection and still runs the other handlers', async () => {
    const ok = vi.fn().mockResolvedValue(undefined)
    issueEventHandlers.push(
      vi.fn().mockRejectedValue(new Error('first boom')),
      ok,
      vi.fn().mockRejectedValue('second boom'),
    )
    const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})

    await expect(handleIssues(new utils.MockContext(issuesLabeledEvent))).resolves.toBeUndefined()

    expect(ok).toHaveBeenCalledTimes(1)
    expect(setFailed).toHaveBeenCalledTimes(1)
    expect(setFailed).toHaveBeenCalledWith('error handling issues event: first boom; second boom')
  })
})
