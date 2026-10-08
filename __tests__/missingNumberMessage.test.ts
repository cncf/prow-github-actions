import type { Context } from '@actions/github/lib/context'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { approve } from '../src/issueComment/approve'
import { assign } from '../src/issueComment/assign'
import { cc } from '../src/issueComment/cc'
import { close } from '../src/issueComment/close'
import { lock } from '../src/issueComment/lock'
import { meow } from '../src/issueComment/meow'
import { milestone } from '../src/issueComment/milestone'
import { reopen } from '../src/issueComment/reopen'
import { retitle } from '../src/issueComment/retitle'
import { retest } from '../src/issueComment/trigger'
import { unassign } from '../src/issueComment/unassign'
import { uncc } from '../src/issueComment/uncc'
import { addFixedLabels, fixedLabelCommands } from '../src/labels/fixed'
import { hold } from '../src/labels/hold'
import { lgtm } from '../src/labels/lgtm'
import { addPrefixedLabels, prefixedLabelCommands } from '../src/labels/prefixed'
import { remove } from '../src/labels/remove'
import { onPrLgtm } from '../src/pullReq/onPrLgtm'

import issueCommentEvent from './fixtures/issues/issueCommentEvent.json'
import pullReqOpenedEvent from './fixtures/pullReq/pullReqOpenedEvent.json'
import * as utils from './testUtils'

// every request is unexpected: the handlers must refuse before calling the API
const server = setupServer()
beforeAll(() =>
  server.listen(utils.failOnUnhandledRequest),
)
beforeEach(() => {
  utils.setupActionsEnv()
})
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

const helpCommand = fixedLabelCommands.find(cmd => cmd.command === '/help')!
const lifecycleCommand = prefixedLabelCommands.find(cmd => cmd.command === '/lifecycle')!

function commentWithoutIssue(body: string): Context {
  const payload = structuredClone(issueCommentEvent) as Record<string, any>
  payload.comment.body = body
  delete payload.issue
  return new utils.MockContext(payload)
}

function pullRequestEventWithoutPullRequest(): Context {
  const payload = structuredClone(pullReqOpenedEvent) as Record<string, unknown>
  delete payload.pull_request
  return new utils.MockContext(payload)
}

describe('missing issue or pull number errors', () => {
  it.each<[string, string, () => Context, (context: Context) => Promise<void>]>([
    ['issueComment/approve', 'issue', () => commentWithoutIssue('/approve'), approve],
    ['issueComment/assign', 'issue', () => commentWithoutIssue('/assign'), assign],
    ['issueComment/cc', 'pull', () => commentWithoutIssue('/cc'), cc],
    ['issueComment/close', 'issue', () => commentWithoutIssue('/close'), close],
    ['issueComment/lock', 'issue', () => commentWithoutIssue('/lock'), lock],
    ['issueComment/meow', 'issue', () => commentWithoutIssue('/meow'), meow],
    ['issueComment/milestone', 'issue', () => commentWithoutIssue('/milestone v1.0'), milestone],
    ['issueComment/reopen', 'issue', () => commentWithoutIssue('/reopen'), reopen],
    ['issueComment/retitle', 'issue', () => commentWithoutIssue('/retitle a new title'), retitle],
    ['issueComment/trigger', 'issue', () => commentWithoutIssue('/retest'), retest],
    ['issueComment/unassign', 'issue', () => commentWithoutIssue('/unassign'), unassign],
    ['issueComment/uncc', 'pull', () => commentWithoutIssue('/uncc'), uncc],
    ['labels/fixed', 'issue', () => commentWithoutIssue('/help'), context => addFixedLabels(context, helpCommand)],
    ['labels/hold', 'issue', () => commentWithoutIssue('/hold'), hold],
    ['labels/lgtm', 'issue', () => commentWithoutIssue('/lgtm'), lgtm],
    ['labels/prefixed', 'issue', () => commentWithoutIssue('/lifecycle stale'), context => addPrefixedLabels(context, lifecycleCommand)],
    ['labels/remove', 'issue', () => commentWithoutIssue('/remove bug'), remove],
    ['pullReq/onPrLgtm', 'pr', pullRequestEventWithoutPullRequest, onPrLgtm],
  ])('%s prints the payload, not [object Object]', async (_name, kind, contextFor, handler) => {
    const context = contextFor()

    const error: Error = await handler(context).then(
      () => { throw new Error('expected the handler to reject') },
      (e: Error) => e,
    )

    expect(error.message).toBe(
      `github context payload missing ${kind} number: ${JSON.stringify(context.payload)}`,
    )
    expect(error.message).not.toContain('[object Object]')
  })
})
