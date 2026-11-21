import { Buffer } from 'node:buffer'

import * as core from '@actions/core'
import { http } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { addPrefixedLabels, dynamicPrefixedCommand, prefixedLabelCommands, removePrefixedLabels } from '../../src/labels/prefixed'

import issuePayload from '../fixtures/issues/issue.json'
import issueCommentEvent from '../fixtures/issues/issueCommentEvent.json'
import labelFileContents from '../fixtures/labels/labelFileContentsResp.json'
import * as utils from '../testUtils'

const server = setupServer()
utils.failTestOnUnhandledRequests(server)
beforeAll(() => server.listen(utils.failOnUnhandledRequest))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

const area = dynamicPrefixedCommand('area')

function serveLabelConfig() {
  server.use(
    http.get(`${utils.api}/repos/Codertocat/Hello-World/contents/.prowlabels.yaml`, utils.mockResponse(200, labelFileContents)),
    ...utils.noOrgOrRepoConfigExcept('.prowlabels.yaml'),
  )
}

describe('prefixed label commands', () => {
  beforeEach(() => {
    utils.setupActionsEnv('/area')
  })

  it.each([
    ['addPrefixedLabels', addPrefixedLabels],
    ['removePrefixedLabels', removePrefixedLabels],
  ])('%s throws when the payload carries no issue number', async (_name, command) => {
    const payload = structuredClone(issueCommentEvent) as Record<string, unknown>
    delete payload.issue
    const context = new utils.MockContext(payload)

    await expect(command(context, area)).rejects.toThrow('github context payload missing issue number')
  })

  it('removePrefixedLabels wraps a failure to read the current labels', async () => {
    issueCommentEvent.comment.body = '/remove-area bug'
    const context = new utils.MockContext(issueCommentEvent)
    serveLabelConfig()
    server.use(
      http.get(`${utils.api}/repos/Codertocat/Hello-World/issues/1`, utils.mockResponse(500, { message: 'boom' })),
    )

    await expect(removePrefixedLabels(context, area)).rejects.toThrow('could not get labels from issue:')
  })
})

// The refusal and debug messages name the command without its slash
// (`area:`, not `/area:`): pinned here because every other assertion on them
// is a substring match, which a `/`-prefixed message would also satisfy.
describe('prefixed label command messages', () => {
  const level = dynamicPrefixedCommand('level')
  const label = prefixedLabelCommands.find(cmd => cmd.command === '/label')!
  const withProtected = structuredClone(labelFileContents)
  withProtected.content = Buffer.from('labels:\n  - documentation\n  - hold\n').toString('base64')

  beforeEach(() => {
    utils.setupActionsEnv('/area')
    serveLabelConfig()
  })

  function comment(body: string) {
    const payload = structuredClone(issueCommentEvent)
    payload.comment.body = body
    return new utils.MockContext(payload)
  }

  it('addPrefixedLabels fails a command without arguments as `<command>: command args missing from body`', async () => {
    await expect(addPrefixedLabels(comment('/area'), area)).rejects.toThrow(
      /^area: command args missing from body$/,
    )
  })

  it('removePrefixedLabels fails a value outside the allowlist as `remove-<command>: no allowed value …`', async () => {
    await expect(removePrefixedLabels(comment('/remove-area nope'), area)).rejects.toThrow(
      /^remove-area: no allowed value in "nope"; allowed: bug, important$/,
    )
  })

  it('addPrefixedLabels fails two values of an exclusive section as `<command>: /<command> takes one value …`', async () => {
    await expect(addPrefixedLabels(comment('/level sandbox incubation'), level)).rejects.toThrow(
      /^level: \/level takes one value; got level\/sandbox, level\/incubation$/,
    )
  })

  it('addPrefixedLabels refuses a protected label as `label: <label> is managed by its own command …`', async () => {
    utils.setupActionsEnv('/label')
    server.use(
      http.get(`${utils.api}/repos/Codertocat/Hello-World/contents/.prowlabels.yaml`, utils.mockResponse(200, withProtected)),
    )

    await expect(addPrefixedLabels(comment('/label hold'), label)).rejects.toThrow(
      /^label: hold is managed by its own command and cannot be changed with \/label$/,
    )
  })

  it('removePrefixedLabels logs the issue labels and the absent value, without a delete, when none of the requested labels are on the issue', async () => {
    const observeDelete = new utils.ObserveRequest()
    server.use(
      http.get(`${utils.api}/repos/Codertocat/Hello-World/issues/1`, utils.mockResponse(200, issuePayload)),
      http.delete(`${utils.api}/repos/Codertocat/Hello-World/issues/1/labels/:name`, utils.mockResponse(200, null, observeDelete)),
    )
    const debug = vi.spyOn(core, 'debug').mockImplementation(() => {})

    await expect(removePrefixedLabels(comment('/remove-area important'), area)).resolves.toBeUndefined()

    expect(debug).toHaveBeenCalledWith('remove-area: found labels for issue some-label,some-other-label')
    expect(debug).toHaveBeenCalledWith('remove-area: none of area/important are on the issue')
    await expect(observeDelete.notCalled()).resolves.toBe('not called')
  })
})
