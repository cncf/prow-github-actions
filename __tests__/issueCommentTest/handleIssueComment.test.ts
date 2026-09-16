import { Buffer } from 'node:buffer'
import * as core from '@actions/core'
import { http } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import * as approve from '../../src/issueComment/approve'
import * as assign from '../../src/issueComment/assign'
import * as cc from '../../src/issueComment/cc'
import { handleIssueComment } from '../../src/issueComment/handleIssueComment'
import * as unassign from '../../src/issueComment/unassign'
import * as fixed from '../../src/labels/fixed'
import * as hold from '../../src/labels/hold'
import * as lgtm from '../../src/labels/lgtm'
import * as prefixed from '../../src/labels/prefixed'
import * as requireMatchingLabel from '../../src/plugins/requireMatchingLabel'
import * as tide from '../../src/plugins/tide'
import issueCommentEvent from '../fixtures/issues/issueCommentEvent.json'
import labelFileContents from '../fixtures/labels/labelFileContentsResp.json'

import * as utils from '../testUtils'
import { prCommentEvent, prHandlers, pullHandler, repo } from '../utils/ownersFixtures'

const server = setupServer()
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))

// the dispatch tests below mock every command; the sweep that follows a command is stubbed the same way
let sweepStubs: ReturnType<typeof vi.spyOn>[]
beforeEach(() => {
  sweepStubs = [
    vi.spyOn(requireMatchingLabel, 'checkRequiredLabels').mockResolvedValue(),
    vi.spyOn(tide, 'tideOnComment').mockResolvedValue(),
  ]
})
afterEach(() => {
  server.resetHandlers()
  server.events.removeAllListeners()
})
afterAll(() => server.close())

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

it('ignores a command inside a fenced code block', async () => {
  utils.setupActionsEnv('/kind')

  const add = vi.spyOn(prefixed, 'addPrefixedLabels').mockImplementation(() => Promise.resolve())
  const remove = vi.spyOn(prefixed, 'removePrefixedLabels').mockImplementation(() => Promise.resolve())
  const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})

  issueCommentEvent.comment.body = 'try:\n```\n/kind bug\n```'
  const context = new utils.MockContext(issueCommentEvent)

  await handleIssueComment(context)
  expect(add).not.toHaveBeenCalled()
  expect(remove).not.toHaveBeenCalled()
  expect(setFailed).not.toHaveBeenCalled()
})

it('ignores a command inside an indented code block', async () => {
  utils.setupActionsEnv('/hold')

  vi.spyOn(hold, 'hold').mockImplementation(() => Promise.resolve())
  const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})

  issueCommentEvent.comment.body = 'try:\n\n    /hold'
  const context = new utils.MockContext(issueCommentEvent)

  await handleIssueComment(context)
  expect(hold.hold).not.toHaveBeenCalled()
  expect(setFailed).not.toHaveBeenCalled()
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

describe('after a command ran', () => {
  const kindRule = 'require_matching_label:\n  - regexp: ^kind/\n    missing_label: needs-kind\n'
  const noRule = ''

  let calls: string[]

  function serveConfig(yamlText: string) {
    const file = structuredClone(labelFileContents)
    file.content = Buffer.from(`labels:\n  kind: [cleanup]\n${yamlText}`).toString('base64')
    server.use(
      http.get(utils.contentsUrl('.github/prow.yaml'), utils.mockResponse(200, file)),
      ...utils.noOrgOrRepoConfigExcept('.github/prow.yaml'),
    )
  }

  function ok(method: 'get' | 'post' | 'put' | 'delete', path: string, body: unknown = {}) {
    return http[method](`${repo}${path}`, utils.mockResponse(200, body))
  }

  // the commenter is an org member, not the pr author, and the repository has no OWNERS files
  function reviewerHandlers() {
    return [
      http.get(`${utils.api}/orgs/Codertocat/members/Codertocat`, utils.mockResponse(204)),
      http.get(`${repo}/collaborators/Codertocat`, utils.mockResponse(404)),
      http.get(`${repo}/contents/OWNERS`, utils.mockResponse(404)),
      utils.defaultBranchTree(),
    ]
  }

  beforeEach(() => {
    sweepStubs.forEach(stub => stub.mockRestore())
    calls = []
    server.events.on('request:start', ({ request }) => {
      calls.push(`${request.method} ${new URL(request.url).pathname}`)
    })
  })

  it('/lgtm on a clean pull request adds the label and merges in the same run', async () => {
    utils.setupActionsEnv('/lgtm')
    serveConfig(noRule)
    server.use(
      ...reviewerHandlers(),
      utils.repoHasLabels(['lgtm']),
      ok('post', '/issues/1/labels', []),
      ...prHandlers({}, ['src/file1.txt'], { labels: [{ name: 'lgtm' }] }),
      http.post(`${repo}/statuses/headsha`, utils.mockResponse(201, {})),
      utils.lgtmStatus('headsha'),
      ok('put', '/pulls/1/merge', { merged: true }),
    )
    const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})

    await handleIssueComment(new utils.MockContext(prCommentEvent('/lgtm')))

    // the binding status goes first so that no unbound label is ever left behind
    const writes = calls.filter(call => !call.startsWith('GET'))
    expect(writes).toEqual([`POST /repos/Codertocat/Hello-World/statuses/headsha`, `POST /repos/Codertocat/Hello-World/issues/1/labels`, `PUT /repos/Codertocat/Hello-World/pulls/1/merge`])
    expect(calls.lastIndexOf('GET /repos/Codertocat/Hello-World/pulls/1')).toBeGreaterThan(calls.indexOf('POST /repos/Codertocat/Hello-World/issues/1/labels'))
    expect(setFailed).not.toHaveBeenCalled()
  })

  it('merge_on_events: false leaves the merge to the cron', async () => {
    utils.setupActionsEnv('/lgtm')
    serveConfig('tide:\n  merge_on_events: false\n')
    server.use(...reviewerHandlers(), utils.repoHasLabels(['lgtm']), ok('post', '/issues/1/labels', []), ...prHandlers({}, ['src/file1.txt']), http.post(`${repo}/statuses/headsha`, utils.mockResponse(201, {})))

    await handleIssueComment(new utils.MockContext(prCommentEvent('/lgtm')))

    expect(calls).toContain('POST /repos/Codertocat/Hello-World/issues/1/labels')
    expect(calls.filter(call => call === 'GET /repos/Codertocat/Hello-World/pulls/1')).toHaveLength(1)
    expect(calls.some(call => call.startsWith('PUT'))).toBe(false)
  })

  it('/lgtm on an issue never reads a pull request', async () => {
    utils.setupActionsEnv('/lgtm')
    serveConfig(noRule)
    server.use(...reviewerHandlers(), utils.repoHasLabels(['lgtm']), ok('post', '/issues/1/labels', []))
    const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})

    const event = structuredClone(issueCommentEvent)
    event.comment.body = '/lgtm'
    event.issue.user.login = 'some-author'
    await handleIssueComment(new utils.MockContext(event))

    expect(calls).toContain('POST /repos/Codertocat/Hello-World/issues/1/labels')
    expect(calls.some(call => call.includes('/pulls/'))).toBe(false)
    expect(setFailed).not.toHaveBeenCalled()
  })

  it('/assign on a pull request makes only its own calls: no configuration probe, no labels or pull request read', async () => {
    utils.setupActionsEnv('/assign')
    server.use(
      http.get(`${utils.api}/orgs/Codertocat/members/bob`, utils.mockResponse(204)),
      http.get(`${repo}/collaborators/bob`, utils.mockResponse(404)),
      ok('get', '/issues/1/comments', []),
      http.post(`${repo}/issues/1/assignees`, utils.mockResponse(201, {})),
    )
    const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})

    await handleIssueComment(new utils.MockContext(prCommentEvent('/assign @bob')))

    expect(calls).toEqual([
      'GET /orgs/Codertocat/members/bob',
      'GET /repos/Codertocat/Hello-World/collaborators/bob',
      'GET /repos/Codertocat/Hello-World/issues/1/comments',
      'POST /repos/Codertocat/Hello-World/issues/1/assignees',
    ])
    expect(setFailed).not.toHaveBeenCalled()
  })

  it('a comment without a configured command makes no api call at all', async () => {
    utils.setupActionsEnv('/lgtm')

    await handleIssueComment(new utils.MockContext(prCommentEvent('looks good to me')))

    expect(calls).toEqual([])
  })

  it('/kind cleanup removes a needs-kind the command just satisfied', async () => {
    utils.setupActionsEnv('/kind')
    serveConfig(kindRule)
    server.use(
      utils.defaultBranchTree(),
      utils.repoHasLabels(['kind/cleanup', 'needs-kind']),
      ok('post', '/issues/1/labels', []),
      ok('get', '/issues/1', { labels: [{ name: 'needs-kind' }, { name: 'kind/cleanup' }] }),
      ok('delete', '/issues/1/labels/needs-kind', []),
      pullHandler(undefined, { labels: [{ name: 'kind/cleanup' }] }),
    )
    const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})

    await handleIssueComment(new utils.MockContext(prCommentEvent('/kind cleanup')))

    expect(calls.filter(call => !call.startsWith('GET'))).toEqual([
      'POST /repos/Codertocat/Hello-World/issues/1/labels',
      'DELETE /repos/Codertocat/Hello-World/issues/1/labels/needs-kind',
    ])
    expect(calls).toContain('GET /repos/Codertocat/Hello-World/pulls/1')
    expect(setFailed).not.toHaveBeenCalled()
  })

  it('/remove-kind that leaves no kind label adds needs-kind and the missing comment', async () => {
    utils.setupActionsEnv('/kind')
    serveConfig(`${kindRule}    missing_comment: Please add a kind label.\n`)
    const postedLabels = new utils.ObserveRequest()
    const postedComment = new utils.ObserveRequest()
    const issueReads = [{ labels: [{ name: 'kind/cleanup' }] }, { labels: [] }]
    server.use(
      utils.defaultBranchTree(),
      http.get(`${repo}/issues/1`, () => new Response(JSON.stringify(issueReads.length > 1 ? issueReads.shift() : issueReads[0]), { status: 200, headers: { 'Content-Type': 'application/json' } })),
      http.delete(`${repo}/issues/1/labels/kind%2Fcleanup`, utils.mockResponse(200, [])),
      utils.repoHasLabels(['kind/cleanup', 'needs-kind']),
      http.post(`${repo}/issues/1/labels`, utils.mockResponse(200, [], postedLabels)),
      ok('get', '/issues/1/comments', []),
      http.post(`${repo}/issues/1/comments`, utils.mockResponse(201, {}, postedComment)),
      pullHandler(undefined, { labels: [{ name: 'needs-kind' }] }),
    )
    const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})

    await handleIssueComment(new utils.MockContext(prCommentEvent('/remove-kind cleanup')))

    expect(await postedLabels.body()).toEqual({ labels: ['needs-kind'] })
    expect(await postedComment.body().then(body => body.body)).toContain('Please add a kind label.')
    expect(setFailed).not.toHaveBeenCalled()
  })

  it('a refused command still runs the sweep and fails with the command message', async () => {
    utils.setupActionsEnv('/lgtm')
    serveConfig(noRule)
    server.use(
      utils.defaultBranchTree(),
      ok('post', '/issues/1/comments', {}),
      pullHandler(undefined, { labels: [] }),
      ok('put', '/pulls/1/merge', { merged: true }),
    )
    const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})
    vi.spyOn(core, 'error').mockImplementation(() => {})

    await handleIssueComment(new utils.MockContext(prCommentEvent('/lgtm', 'Codertocat', 'Codertocat')))

    expect(setFailed).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('you cannot LGTM your own PR.'))
    expect(calls).toContain('GET /repos/Codertocat/Hello-World/pulls/1')
    expect(calls.some(call => call.startsWith('PUT'))).toBe(false)
  })

  it('a closed pull request is not evaluated', async () => {
    utils.setupActionsEnv('/lgtm')
    serveConfig(noRule)
    server.use(...reviewerHandlers(), utils.repoHasLabels(['lgtm']), ok('post', '/issues/1/labels', []))
    const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})

    const event = prCommentEvent('/lgtm')
    event.issue.state = 'closed'
    server.use(...prHandlers({}, ['src/file1.txt'], { state: 'closed' }), http.post(`${repo}/statuses/headsha`, utils.mockResponse(201, {})))
    await handleIssueComment(new utils.MockContext(event))

    expect(calls).toContain('POST /repos/Codertocat/Hello-World/issues/1/labels')
    expect(calls.filter(call => call === 'GET /repos/Codertocat/Hello-World/pulls/1')).toHaveLength(1)
    expect(setFailed).not.toHaveBeenCalled()
  })

  it('a refused merge fails the run naming the pull request', async () => {
    utils.setupActionsEnv('/lgtm')
    serveConfig(noRule)
    server.use(
      ...reviewerHandlers(),
      utils.repoHasLabels(['lgtm']),
      ok('post', '/issues/1/labels', []),
      ...prHandlers({}, ['src/file1.txt'], { labels: [{ name: 'lgtm' }] }),
      http.post(`${repo}/statuses/headsha`, utils.mockResponse(201, {})),
      utils.lgtmStatus('headsha'),
      http.put(`${repo}/pulls/1/merge`, utils.mockResponse(405, { message: 'Pull Request is not mergeable' })),
    )
    const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})
    vi.spyOn(core, 'error').mockImplementation(() => {})

    await handleIssueComment(new utils.MockContext(prCommentEvent('/lgtm')))

    expect(setFailed).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('could not merge pull request(s) #1'))
  })
})
