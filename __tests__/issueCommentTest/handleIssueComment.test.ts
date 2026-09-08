import { expect, it, vi } from 'vitest'

import * as assign from '../../src/issueComment/assign'
import * as cc from '../../src/issueComment/cc'
import { handleIssueComment } from '../../src/issueComment/handleIssueComment'
import * as unassign from '../../src/issueComment/unassign'
import issueCommentEvent from '../fixtures/issues/issueCommentEvent.json'

import * as utils from '../testUtils'

it('ignores the comment if no command in comment', async () => {
  utils.setupActionsEnv('/assign')

  vi.spyOn(assign, 'assign')
  const commentContext = new utils.MockContext(issueCommentEvent)

  await handleIssueComment(commentContext)
  expect(assign.assign).toHaveBeenCalledTimes(0)
})

it('can handle multiple commands in prow-commands config', async () => {
  utils.setupActionsEnv('/assign /unassign')

  vi.spyOn(assign, 'assign').mockImplementation(() => Promise.resolve())
  vi.spyOn(unassign, 'unassign').mockImplementation(() => Promise.resolve())

  issueCommentEvent.comment.body = '/assign'
  const assignContext = new utils.MockContext(issueCommentEvent)

  await handleIssueComment(assignContext)
  expect(assign.assign).toHaveBeenCalledTimes(1)

  issueCommentEvent.comment.body = '/unassign'
  const unassignContext = new utils.MockContext(issueCommentEvent)

  await handleIssueComment(unassignContext)
  expect(unassign.unassign).toHaveBeenCalledTimes(1)
})

it('can handle comments with multiple commands', async () => {
  utils.setupActionsEnv('/assign /unassign')

  vi.spyOn(assign, 'assign').mockImplementation(() => Promise.resolve())
  vi.spyOn(unassign, 'unassign').mockImplementation(() => Promise.resolve())

  issueCommentEvent.comment.body
    = '/assign @some-user @other-user\n/unassign @bad-user'
  const context = new utils.MockContext(issueCommentEvent)

  await handleIssueComment(context)
  expect(assign.assign).toHaveBeenCalledTimes(1)
  expect(unassign.unassign).toHaveBeenCalledTimes(1)
})

it('handles commands on multiple lines', async () => {
  utils.setupActionsEnv(`/assign\n/unassign`)

  vi.spyOn(assign, 'assign').mockImplementation(() => Promise.resolve())
  vi.spyOn(unassign, 'unassign').mockImplementation(() => Promise.resolve())

  issueCommentEvent.comment.body
    = '/assign @some-user @other-user\n/unassign @bad-user'
  const context = new utils.MockContext(issueCommentEvent)

  await handleIssueComment(context)
  expect(assign.assign).toHaveBeenCalledTimes(1)
  expect(unassign.unassign).toHaveBeenCalledTimes(1)
})

it('handles commands on both newlines and spaces', async () => {
  utils.setupActionsEnv(`/assign\n/unassign /cc`)

  vi.spyOn(assign, 'assign').mockImplementation(() => Promise.resolve())
  vi.spyOn(unassign, 'unassign').mockImplementation(() => Promise.resolve())
  vi.spyOn(cc, 'cc').mockImplementation(() => Promise.resolve())

  issueCommentEvent.comment.body
    = '/assign @some-user @other-user\n/unassign @bad-user\n/cc @some-user'
  const context = new utils.MockContext(issueCommentEvent)

  await handleIssueComment(context)
  expect(assign.assign).toHaveBeenCalledTimes(1)
  expect(unassign.unassign).toHaveBeenCalledTimes(1)
  expect(cc.cc).toHaveBeenCalledTimes(1)
})
