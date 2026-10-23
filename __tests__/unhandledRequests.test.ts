import { http } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import * as utils from './testUtils'

const server = setupServer()
const unhandled = utils.failTestOnUnhandledRequests(server)
beforeAll(() => server.listen(utils.failOnUnhandledRequest))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

const url = `${utils.api}/repos/Codertocat/Hello-World/pulls/1`

// what the code under test does with a request failOnUnhandledRequest rejected
async function swallow(target: string) {
  await fetch(target).catch(() => undefined)
}

describe('failTestOnUnhandledRequests', () => {
  it('records a request no handler served even though the caller swallowed the rejection', async () => {
    await swallow(url)

    expect(unhandled.seen()).toEqual([`GET ${url}`])
    expect(() => unhandled.check()).toThrow(`1 request(s) no handler served (a test that leaves one unserved on purpose calls .allow() on the object failTestOnUnhandledRequests returned):\n  GET ${url}`)
    unhandled.allow()
  })

  it('does not count a served request, nor one answered with a network error on purpose', async () => {
    server.use(
      http.get(url, utils.mockResponse(200, { number: 1 })),
      http.get(`${url}/files`, () => Response.error()),
    )

    await fetch(url)
    await swallow(`${url}/files`)

    expect(unhandled.seen()).toEqual([])
    expect(() => unhandled.check()).not.toThrow()
  })

  it('allow() exempts the current test only', async () => {
    unhandled.allow()
    await swallow(url)

    expect(unhandled.seen()).toEqual([`GET ${url}`])
    expect(() => unhandled.check()).not.toThrow()
  })

  it('starts the next test with nothing recorded and no allowance', () => {
    expect(unhandled.seen()).toEqual([])
    expect(() => unhandled.check()).not.toThrow()
  })

  it('a test that calls server.events.removeAllListeners() disarms only itself', async () => {
    server.events.removeAllListeners()
    await swallow(url)

    // the listener is re-attached before every test, so the removal only reaches this one
    expect(unhandled.seen()).toEqual([])
    unhandled.allow()
  })

  it('is listening again after the test that removed every listener', async () => {
    await swallow(url)

    expect(unhandled.seen()).toEqual([`GET ${url}`])
    unhandled.allow()
  })
})
