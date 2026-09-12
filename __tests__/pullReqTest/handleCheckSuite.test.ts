import * as core from '@actions/core'
import { http } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { checkSuiteHandlers, handleCheckSuite, pullRequestsForSha } from '../../src/pullReq/handleCheckSuite'
import { newOctokit } from '../../src/utils/octokit'
import checkSuiteCompletedEvent from '../fixtures/pullReq/checkSuiteCompletedEvent.json'
import * as utils from '../testUtils'

const server = setupServer()
beforeAll(() =>
  server.listen({
    onUnhandledRequest: 'error',
  }),
)
afterEach(() => {
  server.resetHandlers()
  checkSuiteHandlers.length = 0
})
afterAll(() => server.close())

const sha = checkSuiteCompletedEvent.check_suite.head_sha

describe('handleCheckSuite', () => {
  beforeEach(() => {
    utils.setupActionsEnv()
  })

  it.each(['check_suite', 'status'])('resolves a %s event without calling the api or failing when no handlers are registered', async (eventName) => {
    const context = new utils.MockContext(checkSuiteCompletedEvent)
    context.eventName = eventName
    const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})
    const debug = vi.spyOn(core, 'debug').mockImplementation(() => {})

    await expect(handleCheckSuite(context)).resolves.toBeUndefined()

    expect(setFailed).not.toHaveBeenCalled()
    expect(debug).toHaveBeenCalledWith(`${eventName} event completed received; no handlers registered yet`)
  })

  it('runs every registered handler with the context', async () => {
    const first = vi.fn().mockResolvedValue(undefined)
    const second = vi.fn().mockResolvedValue(undefined)
    checkSuiteHandlers.push(first, second)
    const context = new utils.MockContext(checkSuiteCompletedEvent)
    context.eventName = 'check_suite'
    const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})

    await handleCheckSuite(context)

    expect(first).toHaveBeenCalledWith(context)
    expect(second).toHaveBeenCalledWith(context)
    expect(setFailed).not.toHaveBeenCalled()
  })

  it('fails once with the aggregated rejection message', async () => {
    checkSuiteHandlers.push(vi.fn().mockRejectedValue(new Error('suite boom')))
    const context = new utils.MockContext(checkSuiteCompletedEvent)
    context.eventName = 'check_suite'
    const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})

    await expect(handleCheckSuite(context)).resolves.toBeUndefined()

    expect(setFailed).toHaveBeenCalledTimes(1)
    expect(setFailed).toHaveBeenCalledWith('error handling check_suite event: suite boom')
  })
})

describe('pullRequestsForSha', () => {
  function servePages(pages: { number: number, sha: string }[][]) {
    const seen: string[] = []
    server.use(
      http.get(`${utils.api}/repos/Codertocat/Hello-World/pulls`, ({ request }) => {
        const url = new URL(request.url)
        seen.push(url.search)
        const page = Number(url.searchParams.get('page'))
        const body = (pages[page - 1] ?? []).map(pr => ({ number: pr.number, head: { sha: pr.sha } }))
        return new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }),
    )
    return seen
  }

  it('returns the numbers of the open prs whose head is the sha across pages', async () => {
    const seen = servePages([
      [{ number: 2, sha }, { number: 3, sha: 'other' }],
      [{ number: 5, sha }],
    ])

    const context = new utils.MockContext(checkSuiteCompletedEvent)
    await expect(pullRequestsForSha(newOctokit('some-token'), context, sha)).resolves.toEqual([2, 5])
    expect(seen).toEqual([
      '?state=open&per_page=100&page=1',
      '?state=open&per_page=100&page=2',
      '?state=open&per_page=100&page=3',
    ])
  })

  it('returns an empty list when no open pr has the sha', async () => {
    servePages([[{ number: 2, sha: 'other' }]])

    const context = new utils.MockContext(checkSuiteCompletedEvent)
    await expect(pullRequestsForSha(newOctokit('some-token'), context, sha)).resolves.toEqual([])
  })

  it('returns an empty list when the repository has no open prs', async () => {
    servePages([])

    const context = new utils.MockContext(checkSuiteCompletedEvent)
    await expect(pullRequestsForSha(newOctokit('some-token'), context, sha)).resolves.toEqual([])
  })
})
