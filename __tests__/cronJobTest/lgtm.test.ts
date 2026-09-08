import { http } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { handleCronJobs } from '../../src/cronJobs/handleCronJob'
import listPullReqs from '../fixtures/pullReq/pullReqListPulls.json'

import pullReqOpenedEvent from '../fixtures/pullReq/pullReqOpenedEvent.json'
import * as utils from '../testUtils'

const server = setupServer(
  // /repos/Codertocat/Hello-World/pulls?state=open&page={1,2}
  http.get(
    `${utils.api}/repos/Codertocat/Hello-World/pulls`,
    ({ request }) => {
      const url = new URL(request.url)
      const page = url.searchParams.get('page')

      if (page === '1') {
        return new Response(JSON.stringify(listPullReqs), {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
          },
        })
      }
      else {
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
          },
        })
      }
    },
  ),
)
beforeAll(() =>
  server.listen({
    onUnhandledRequest: 'error',
  }),
)
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

describe('cronLgtm', () => {
  it('merges the PR if the lgtm label is present', async () => {
    utils.setupJobsEnv('lgtm')

    // We can use any context here as "schedule" sends no webhook payload
    // Instead, we use it to gain the repo owner and url
    const context = new utils.MockContext(pullReqOpenedEvent)

    listPullReqs[0].labels[0].name = 'lgtm'

    const observeReq = new utils.ObserveRequest()
    server.use(
      http.put(
        `${utils.api}/repos/Codertocat/Hello-World/pulls/2/merge`,
        utils.mockResponse(200, null, observeReq),
      ),
    )

    await expect(handleCronJobs(context)).resolves.not.toThrow()
    expect(await observeReq.body()).toEqual({
      merge_method: 'merge',
    })
  })

  it('merges the PR with squash configured', async () => {
    utils.setupJobsEnv('lgtm')
    process.env['INPUT_MERGE-METHOD'] = 'squash'

    // We can use any context here as "schedule" sends no webhook payload
    // Instead, we use it to gain the repo owner and url
    const context = new utils.MockContext(pullReqOpenedEvent)

    listPullReqs[0].labels[0].name = 'lgtm'

    const observeReq = new utils.ObserveRequest()
    server.use(
      http.put(
        `${utils.api}/repos/Codertocat/Hello-World/pulls/2/merge`,
        utils.mockResponse(200, null, observeReq),
      ),
    )

    await expect(handleCronJobs(context)).resolves.not.toThrow()
    expect(await observeReq.body()).toEqual({
      merge_method: 'squash',
    })
  })

  it('merges the PR with rebase configured', async () => {
    utils.setupJobsEnv('lgtm')
    process.env['INPUT_MERGE-METHOD'] = 'rebase'

    // We can use any context here as "schedule" sends no webhook payload
    // Instead, we use it to gain the repo owner and url
    const context = new utils.MockContext(pullReqOpenedEvent)

    listPullReqs[0].labels[0].name = 'lgtm'

    const observeReq = new utils.ObserveRequest()
    server.use(
      http.put(
        `${utils.api}/repos/Codertocat/Hello-World/pulls/2/merge`,
        utils.mockResponse(200, null, observeReq),
      ),
    )

    await expect(handleCronJobs(context)).resolves.not.toThrow()
    expect(await observeReq.body()).toEqual({
      merge_method: 'rebase',
    })
  })

  it('wont merge a locked PR even if the lgtm label is present', async () => {
    utils.setupJobsEnv('lgtm')

    const context = new utils.MockContext(pullReqOpenedEvent)

    const lockedPrs = structuredClone(listPullReqs)
    lockedPrs[0].locked = true
    lockedPrs[0].labels[0].name = 'lgtm'

    const observeReq = new utils.ObserveRequest()
    server.use(
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/pulls`,
        ({ request }) => {
          const page = new URL(request.url).searchParams.get('page')
          return utils.mockResponse(200, page === '1' ? lockedPrs : [])({ request })
        },
      ),
      http.put(
        `${utils.api}/repos/Codertocat/Hello-World/pulls/2/merge`,
        utils.mockResponse(200, null, observeReq),
      ),
    )

    await expect(handleCronJobs(context)).resolves.not.toThrow()
    await expect(observeReq.notCalled()).resolves.toBe('not called')
  })

  it('wont merge the PR if the hold label is present', async () => {
    utils.setupJobsEnv('lgtm')

    // We can use any context here as "schedule" sends no webhook payload
    // Instead, we use it to gain the repo owner and url
    const context = new utils.MockContext(pullReqOpenedEvent)

    listPullReqs[0].labels[0].name = 'lgtm'
    listPullReqs[0].labels.push({
      id: 1,
      node_id: '123',
      url: 'https://api.github.com/repos/octocat/Hello-World/labels/hold',
      name: 'hold',
      description: 'looks good to me',
      color: 'f29513',
      default: true,
    })

    const observeReq = new utils.ObserveRequest()
    server.use(
      http.put(
        `${utils.api}/repos/Codertocat/Hello-World/pulls/2/merge`,
        utils.mockResponse(200, null, observeReq),
      ),
    )

    await expect(handleCronJobs(context)).resolves.not.toThrow()
    await expect(observeReq.notCalled()).resolves.toBe('not called')
  })
})
