import { http } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { handlePullReq } from '../../src/pullReq/handlePullReq'
import issuePayload from '../fixtures/issues/issue.json'

import pullReqEvent from '../fixtures/pullReq/pullReqOpenedEvent.json'
import * as utils from '../testUtils'

const server = setupServer()
beforeAll(() =>
  server.listen({
    onUnhandledRequest: 'error',
  }),
)
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

describe('onPrLgtm', () => {
  beforeEach(() => {
    utils.setupJobsEnv('lgtm')
  })

  it('removes the label lgtm', async () => {
    const prContext = new utils.MockContext(pullReqEvent)

    issuePayload.labels.push({
      id: 1999,
      node_id: 'MEOW111=',
      url: 'https://api.github.com/repos/octocat/Hello-World/labels/lgtm',
      name: 'lgtm',
      description: 'looks good to me',
      color: 'f29513',
      default: false,
    })

    server.use(
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1`,
        utils.mockResponse(200, issuePayload),
      ),
      http.delete(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1/labels/lgtm`,
        utils.mockResponse(200),
      ),
    )

    await expect(handlePullReq(prContext)).resolves.not.toThrow()
  })
})
