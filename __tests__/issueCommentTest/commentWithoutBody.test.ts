import * as core from '@actions/core'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { handleIssueComment } from '../../src/issueComment/handleIssueComment'
import issueCommentEvent from '../fixtures/issues/issueCommentEvent.json'
import * as utils from '../testUtils'

const server = setupServer()
let calls: string[]
beforeAll(() => server.listen(utils.failOnUnhandledRequest))
beforeEach(() => {
  utils.setupActionsEnv('/assign /approve /lgtm /hold /kind /help /meow /retest /check-required-labels')
  calls = []
  server.events.on('request:start', ({ request }) => {
    calls.push(`${request.method} ${request.url}`)
  })
})
afterEach(() => {
  server.resetHandlers()
  server.events.removeAllListeners()
})
afterAll(() => server.close())

function withComment(comment: Record<string, unknown> | undefined) {
  const payload = structuredClone(issueCommentEvent) as Record<string, unknown>
  if (comment === undefined)
    delete payload.comment
  else
    payload.comment = comment
  return new utils.MockContext(payload)
}

const { body: _body, ...commentWithoutBody } = issueCommentEvent.comment

describe('an issue comment without a body', () => {
  it.each([
    ['a null body', () => withComment({ ...commentWithoutBody, body: null })],
    ['no body field', () => withComment(commentWithoutBody)],
    ['no comment at all', () => withComment(undefined)],
  ])('runs no command and succeeds with %s', async (_name, contextFor) => {
    const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})
    const fetchSpy = vi.spyOn(globalThis, 'fetch')

    await expect(handleIssueComment(contextFor())).resolves.toBeUndefined()

    expect(setFailed).not.toHaveBeenCalled()
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(calls).toEqual([])
  })
})
