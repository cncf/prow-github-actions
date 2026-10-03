import { http } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { addPrefixedLabels, dynamicPrefixedCommand, removePrefixedLabels } from '../../src/labels/prefixed'
import issueCommentEvent from '../fixtures/issues/issueCommentEvent.json'
import labelFileContents from '../fixtures/labels/labelFileContentsResp.json'
import * as utils from '../testUtils'

const server = setupServer()
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
