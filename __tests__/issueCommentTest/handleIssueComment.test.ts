import * as core from '@actions/core'
import { expect, it, vi } from 'vitest'

import * as approve from '../../src/issueComment/approve'
import * as assign from '../../src/issueComment/assign'
import * as cc from '../../src/issueComment/cc'
import { handleIssueComment } from '../../src/issueComment/handleIssueComment'
import * as unassign from '../../src/issueComment/unassign'
import * as fixed from '../../src/labels/fixed'
import * as hold from '../../src/labels/hold'
import * as lgtm from '../../src/labels/lgtm'
import * as prefixed from '../../src/labels/prefixed'
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
  utils.setupActionsEnv('/not_a_command')

  const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})

  issueCommentEvent.comment.body = '/not_a_command'
  const context = new utils.MockContext(issueCommentEvent)

  await handleIssueComment(context)
  expect(setFailed).toHaveBeenCalledWith(
    expect.stringContaining('could not execute /not_a_command'),
  )
})

it('dispatches an unknown lower-case command as a dynamic label command', async () => {
  utils.setupActionsEnv('/level')

  const add = vi.spyOn(prefixed, 'addPrefixedLabels').mockImplementation(() => Promise.resolve())
  const remove = vi.spyOn(prefixed, 'removePrefixedLabels').mockImplementation(() => Promise.resolve())
  const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})

  issueCommentEvent.comment.body = '/level incubation'
  const context = new utils.MockContext(issueCommentEvent)

  await handleIssueComment(context)
  expect(add).toHaveBeenCalledTimes(1)
  expect(add.mock.calls[0][1]).toEqual({ command: '/level', prefix: 'level', allowlistKey: 'level' })
  expect(remove).not.toHaveBeenCalled()
  expect(setFailed).not.toHaveBeenCalled()
})

it('dispatches /remove-<key> to the remove path of a dynamic label command', async () => {
  utils.setupActionsEnv('/level')

  const add = vi.spyOn(prefixed, 'addPrefixedLabels').mockImplementation(() => Promise.resolve())
  const remove = vi.spyOn(prefixed, 'removePrefixedLabels').mockImplementation(() => Promise.resolve())

  issueCommentEvent.comment.body = '/remove-level incubation'
  const context = new utils.MockContext(issueCommentEvent)

  await handleIssueComment(context)
  expect(remove).toHaveBeenCalledTimes(1)
  expect(remove.mock.calls[0][1]).toMatchObject({ command: '/level' })
  expect(add).not.toHaveBeenCalled()
})

it('listing only /remove-<key> also enables the dynamic /<key>', async () => {
  utils.setupActionsEnv('/remove-level')

  const add = vi.spyOn(prefixed, 'addPrefixedLabels').mockImplementation(() => Promise.resolve())
  const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})

  issueCommentEvent.comment.body = '/level incubation'
  const context = new utils.MockContext(issueCommentEvent)

  await handleIssueComment(context)
  expect(add).toHaveBeenCalledTimes(1)
  expect(add.mock.calls[0][1]).toMatchObject({ command: '/level' })
  expect(setFailed).not.toHaveBeenCalled()
})

it.each([
  ['/help', '/help'],
  ['/good-first-issue', '/good-first-issue'],
  ['/remove-good-first-issue', '/good-first-issue'],
] as const)('dispatches a fixed label command listed as %s to %s', async (config, command) => {
  utils.setupActionsEnv(config)

  const add = vi.spyOn(fixed, 'addFixedLabels').mockImplementation(() => Promise.resolve())
  const remove = vi.spyOn(fixed, 'removeFixedLabels').mockImplementation(() => Promise.resolve())
  const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})

  issueCommentEvent.comment.body = command
  const context = new utils.MockContext(issueCommentEvent)

  await handleIssueComment(context)
  expect(add).toHaveBeenCalledTimes(1)
  expect(add.mock.calls[0][1]).toMatchObject({ command })
  expect(remove).not.toHaveBeenCalled()
  expect(setFailed).not.toHaveBeenCalled()
})

it('runs remove before add when a comment carries both /help and /remove-help', async () => {
  utils.setupActionsEnv('/help')

  const order: string[] = []
  vi.spyOn(fixed, 'addFixedLabels').mockImplementation(async () => {
    order.push('add')
  })
  vi.spyOn(fixed, 'removeFixedLabels').mockImplementation(async () => {
    order.push('remove')
  })

  issueCommentEvent.comment.body = '/help\n/remove-help'
  const context = new utils.MockContext(issueCommentEvent)

  await handleIssueComment(context)
  expect(order).toEqual(['remove', 'add'])
})

it('does not turn /remove-<hand-written command> into a label command', async () => {
  utils.setupActionsEnv('/assign')

  vi.spyOn(assign, 'assign').mockImplementation(() => Promise.resolve())
  const add = vi.spyOn(prefixed, 'addPrefixedLabels').mockImplementation(() => Promise.resolve())
  const remove = vi.spyOn(prefixed, 'removePrefixedLabels').mockImplementation(() => Promise.resolve())

  issueCommentEvent.comment.body = '/remove-assign @some-user'
  const context = new utils.MockContext(issueCommentEvent)

  await handleIssueComment(context)
  expect(assign.assign).not.toHaveBeenCalled()
  expect(add).not.toHaveBeenCalled()
  expect(remove).not.toHaveBeenCalled()
})

it('dispatches /remove-lgtm once to lgtm when /lgtm is configured', async () => {
  utils.setupActionsEnv('/lgtm')

  vi.spyOn(lgtm, 'lgtm').mockImplementation(() => Promise.resolve())
  const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})

  issueCommentEvent.comment.body = '/remove-lgtm'
  const context = new utils.MockContext(issueCommentEvent)

  await handleIssueComment(context)
  expect(lgtm.lgtm).toHaveBeenCalledTimes(1)
  expect(setFailed).not.toHaveBeenCalled()
})

it.each(['/unhold', '/remove-hold'])('dispatches %s once to hold when /hold is configured', async (body) => {
  utils.setupActionsEnv('/hold')

  vi.spyOn(hold, 'hold').mockImplementation(() => Promise.resolve())

  issueCommentEvent.comment.body = body
  const context = new utils.MockContext(issueCommentEvent)

  await handleIssueComment(context)
  expect(hold.hold).toHaveBeenCalledTimes(1)
})

it('dispatches /remove-approve once to approve when /approve is configured', async () => {
  utils.setupActionsEnv('/approve')

  vi.spyOn(approve, 'approve').mockImplementation(() => Promise.resolve())

  issueCommentEvent.comment.body = '/remove-approve'
  const context = new utils.MockContext(issueCommentEvent)

  await handleIssueComment(context)
  expect(approve.approve).toHaveBeenCalledTimes(1)
})

it('accepts an alias in prow-commands and resolves it to the base command', async () => {
  utils.setupActionsEnv('/unhold')

  vi.spyOn(hold, 'hold').mockImplementation(() => Promise.resolve())
  const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})

  issueCommentEvent.comment.body = '/unhold'
  const context = new utils.MockContext(issueCommentEvent)

  await handleIssueComment(context)
  expect(hold.hold).toHaveBeenCalledTimes(1)
  expect(setFailed).not.toHaveBeenCalled()
})

it('runs a command once when both it and an alias are configured', async () => {
  utils.setupActionsEnv('/hold /unhold /remove-hold')

  vi.spyOn(hold, 'hold').mockImplementation(() => Promise.resolve())

  issueCommentEvent.comment.body = '/hold'
  const context = new utils.MockContext(issueCommentEvent)

  await handleIssueComment(context)
  expect(hold.hold).toHaveBeenCalledTimes(1)
})

it('listing only /remove-kind also enables /kind', async () => {
  utils.setupActionsEnv('/remove-kind')

  const add = vi.spyOn(prefixed, 'addPrefixedLabels').mockImplementation(() => Promise.resolve())
  const remove = vi.spyOn(prefixed, 'removePrefixedLabels').mockImplementation(() => Promise.resolve())
  const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})

  issueCommentEvent.comment.body = '/kind cleanup'
  const context = new utils.MockContext(issueCommentEvent)

  await handleIssueComment(context)
  expect(add).toHaveBeenCalledTimes(1)
  expect(add.mock.calls[0][1]).toMatchObject({ command: '/kind' })
  expect(remove).not.toHaveBeenCalled()
  expect(setFailed).not.toHaveBeenCalled()
})

it.each([
  ['/remove-lgtm', '/lgtm', lgtm, 'lgtm'],
  ['/unhold', '/hold', hold, 'hold'],
  ['/remove-approve', '/approve', approve, 'approve'],
] as const)('listing only %s also enables %s', async (alias, base, mod, fn) => {
  utils.setupActionsEnv(alias)

  const spy = vi.spyOn(mod, fn).mockImplementation(() => Promise.resolve())
  const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})

  issueCommentEvent.comment.body = base
  const context = new utils.MockContext(issueCommentEvent)

  await handleIssueComment(context)
  expect(spy).toHaveBeenCalledTimes(1)
  expect(setFailed).not.toHaveBeenCalled()
})

it('does not dispatch an alias whose base command is not configured', async () => {
  utils.setupActionsEnv('/assign')

  vi.spyOn(hold, 'hold').mockImplementation(() => Promise.resolve())
  vi.spyOn(assign, 'assign').mockImplementation(() => Promise.resolve())

  issueCommentEvent.comment.body = '/unhold'
  const context = new utils.MockContext(issueCommentEvent)

  await handleIssueComment(context)
  expect(hold.hold).not.toHaveBeenCalled()
  expect(assign.assign).not.toHaveBeenCalled()
})

it.each(['/area', '/kind', '/priority', '/label'])('dispatches /remove-%s to the remove path only when %s is configured', async (command) => {
  utils.setupActionsEnv(command)

  const add = vi.spyOn(prefixed, 'addPrefixedLabels').mockImplementation(() => Promise.resolve())
  const remove = vi.spyOn(prefixed, 'removePrefixedLabels').mockImplementation(() => Promise.resolve())
  const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})

  issueCommentEvent.comment.body = `${prefixed.removeCommandFor(command)} bug`
  const context = new utils.MockContext(issueCommentEvent)

  await handleIssueComment(context)
  expect(remove).toHaveBeenCalledTimes(1)
  expect(remove.mock.calls[0][1]).toMatchObject({ command })
  expect(add).not.toHaveBeenCalled()
  expect(setFailed).not.toHaveBeenCalled()
})

it('runs remove before add when a comment carries both /kind and /remove-kind', async () => {
  utils.setupActionsEnv('/kind')

  const order: string[] = []
  vi.spyOn(prefixed, 'addPrefixedLabels').mockImplementation(async () => {
    order.push('add')
  })
  vi.spyOn(prefixed, 'removePrefixedLabels').mockImplementation(async () => {
    order.push('remove')
  })

  issueCommentEvent.comment.body = '/kind bug\n/remove-kind cleanup'
  const context = new utils.MockContext(issueCommentEvent)

  await handleIssueComment(context)
  expect(order).toEqual(['remove', 'add'])
})

it('does not dispatch /remove-kind when /kind is not configured', async () => {
  utils.setupActionsEnv('/area')

  const add = vi.spyOn(prefixed, 'addPrefixedLabels').mockImplementation(() => Promise.resolve())
  const remove = vi.spyOn(prefixed, 'removePrefixedLabels').mockImplementation(() => Promise.resolve())

  issueCommentEvent.comment.body = '/remove-kind cleanup'
  const context = new utils.MockContext(issueCommentEvent)

  await handleIssueComment(context)
  expect(add).not.toHaveBeenCalled()
  expect(remove).not.toHaveBeenCalled()
})

it.each(['/area', '/kind', '/priority', '/label'])('ignores a lone /remove-%s alias when %s is not configured', async (command) => {
  utils.setupActionsEnv(command === '/kind' ? '/area' : '/kind')

  const add = vi.spyOn(prefixed, 'addPrefixedLabels').mockImplementation(() => Promise.resolve())
  const remove = vi.spyOn(prefixed, 'removePrefixedLabels').mockImplementation(() => Promise.resolve())
  const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})

  issueCommentEvent.comment.body = `${prefixed.removeCommandFor(command)} x`
  const context = new utils.MockContext(issueCommentEvent)

  await handleIssueComment(context)
  expect(add).not.toHaveBeenCalled()
  expect(remove).not.toHaveBeenCalled()
  expect(setFailed).not.toHaveBeenCalled()
})

it('dispatches an upper-case command in the comment body', async () => {
  utils.setupActionsEnv('/lgtm')

  vi.spyOn(lgtm, 'lgtm').mockImplementation(() => Promise.resolve())
  const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})

  issueCommentEvent.comment.body = '/LGTM'
  const context = new utils.MockContext(issueCommentEvent)

  await handleIssueComment(context)
  expect(lgtm.lgtm).toHaveBeenCalledTimes(1)
  expect(setFailed).not.toHaveBeenCalled()
})

it('accepts a mixed-case entry in prow-commands and dispatches its lower-case command', async () => {
  utils.setupActionsEnv('/Kind')

  const add = vi.spyOn(prefixed, 'addPrefixedLabels').mockImplementation(() => Promise.resolve())
  const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})

  issueCommentEvent.comment.body = '/kind cleanup'
  const context = new utils.MockContext(issueCommentEvent)

  await handleIssueComment(context)
  expect(add).toHaveBeenCalledTimes(1)
  expect(add.mock.calls[0][1]).toMatchObject({ command: '/kind' })
  expect(setFailed).not.toHaveBeenCalled()
})

it('resolves an upper-case alias in prow-commands to its base command', async () => {
  utils.setupActionsEnv('/UNHOLD')

  vi.spyOn(hold, 'hold').mockImplementation(() => Promise.resolve())
  const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})

  issueCommentEvent.comment.body = '/hold'
  const context = new utils.MockContext(issueCommentEvent)

  await handleIssueComment(context)
  expect(hold.hold).toHaveBeenCalledTimes(1)
  expect(setFailed).not.toHaveBeenCalled()
})
