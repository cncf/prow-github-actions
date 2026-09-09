import * as core from '@actions/core'
import { expect, it, vi } from 'vitest'

import * as assign from '../../src/issueComment/assign'
import * as cc from '../../src/issueComment/cc'
import { handleIssueComment } from '../../src/issueComment/handleIssueComment'
import * as unassign from '../../src/issueComment/unassign'
import * as hold from '../../src/labels/hold'
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

it('ignores a command mentioned mid-sentence', async () => {
  utils.setupActionsEnv('/hold')

  vi.spyOn(hold, 'hold').mockImplementation(() => Promise.resolve())
  const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})

  issueCommentEvent.comment.body = 'please do not /hold this yet'
  const context = new utils.MockContext(issueCommentEvent)

  await handleIssueComment(context)
  expect(hold.hold).not.toHaveBeenCalled()
  expect(setFailed).not.toHaveBeenCalled()
})

it('dispatches a command preceded by whitespace', async () => {
  utils.setupActionsEnv('/hold')

  vi.spyOn(hold, 'hold').mockImplementation(() => Promise.resolve())

  issueCommentEvent.comment.body = 'some context\n   /hold'
  const context = new utils.MockContext(issueCommentEvent)

  await handleIssueComment(context)
  expect(hold.hold).toHaveBeenCalledTimes(1)
})

it('tolerates extra whitespace in the prow-commands config', async () => {
  utils.setupActionsEnv('  /assign  \n\n/unassign ')

  vi.spyOn(assign, 'assign').mockImplementation(() => Promise.resolve())
  vi.spyOn(unassign, 'unassign').mockImplementation(() => Promise.resolve())
  const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})

  issueCommentEvent.comment.body = '/assign\n/unassign'
  const context = new utils.MockContext(issueCommentEvent)

  await handleIssueComment(context)
  expect(assign.assign).toHaveBeenCalledTimes(1)
  expect(unassign.unassign).toHaveBeenCalledTimes(1)
  expect(setFailed).not.toHaveBeenCalled()
})

it('fails when prow-commands is empty', async () => {
  utils.setupActionsEnv('')

  const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})

  issueCommentEvent.comment.body = '/assign'
  const context = new utils.MockContext(issueCommentEvent)

  await handleIssueComment(context)
  expect(setFailed).toHaveBeenCalledWith(
    expect.stringContaining('please provide a list of space delimited commands'),
  )
})

it('fails for an unsupported command in prow-commands', async () => {
  utils.setupActionsEnv('/not-a-command')

  const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})

  issueCommentEvent.comment.body = '/not-a-command'
  const context = new utils.MockContext(issueCommentEvent)

  await handleIssueComment(context)
  expect(setFailed).toHaveBeenCalledWith(
    expect.stringContaining('could not execute /not-a-command'),
  )
})
