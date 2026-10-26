import * as core from '@actions/core'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { skipReadOnlyForkRun } from '../../src/utils/events'
import pullReqOpenedEvent from '../fixtures/pullReq/pullReqOpenedEvent.json'
import * as utils from '../testUtils'

const fork = 'octocat/Hello-World'

function context(eventName: string, payload: Record<string, unknown>) {
  const ctx = new utils.MockContext(payload)
  ctx.eventName = eventName
  return ctx
}

let notice: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  notice = vi.spyOn(core, 'notice').mockImplementation(() => {})
})

describe('skipReadOnlyForkRun on a payload missing the fields it compares', () => {
  const forkHead = { ...pullReqOpenedEvent.pull_request, head: { ...pullReqOpenedEvent.pull_request.head, repo: { full_name: fork } } }

  it.each([
    ['no pull_request at all', { action: 'opened' }],
    ['a pull_request without head', { action: 'opened', pull_request: { number: 2 }, repository: pullReqOpenedEvent.repository }],
    ['a fork head but no repository', { action: 'opened', pull_request: forkHead }],
    ['a fork head but a repository without full_name', { action: 'opened', pull_request: forkHead, repository: { name: 'Hello-World' } }],
    ['a fork head but a non-string repository full_name', { action: 'opened', pull_request: forkHead, repository: { full_name: 42 } }],
  ])('%s: not skipped, no notice, no throw', (_name, payload) => {
    for (const eventName of ['pull_request', 'pull_request_review']) {
      expect(skipReadOnlyForkRun(context(eventName, payload))).toBe(false)
    }
    expect(notice).not.toHaveBeenCalled()
  })

  it('still skips once both names are present and differ', () => {
    expect(skipReadOnlyForkRun(context('pull_request', { action: 'opened', pull_request: forkHead, repository: pullReqOpenedEvent.repository }))).toBe(true)
    expect(notice).toHaveBeenCalledTimes(1)
  })
})
