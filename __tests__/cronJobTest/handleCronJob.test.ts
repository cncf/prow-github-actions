import * as core from '@actions/core'
import { http } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { handleCronJobs } from '../../src/cronJobs/handleCronJob'
import listPullReqs from '../fixtures/pullReq/pullReqListPulls.json'
import pullReqOpenedEvent from '../fixtures/pullReq/pullReqOpenedEvent.json'

import * as utils from '../testUtils'

const server = setupServer()
beforeAll(() =>
  server.listen({
    onUnhandledRequest: 'error',
  }),
)
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

function serveMergeablePr(options: { updatedNow?: boolean } = {}) {
  const payload = structuredClone(listPullReqs)
  payload[0].labels[0].name = 'lgtm'
  if (options.updatedNow === true) {
    payload[0].updated_at = new Date().toISOString()
  }
  server.use(
    ...utils.noOrgOrRepoConfigExcept(),
    utils.defaultBranchTree(),
    utils.lgtmStatus(),
    http.get(`${utils.api}/repos/Codertocat/Hello-World/pulls`, ({ request }) => {
      const page = new URL(request.url).searchParams.get('page')
      return new Response(JSON.stringify(page === '1' ? payload : []), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }),
    http.get(`${utils.api}/repos/Codertocat/Hello-World/pulls/2`, utils.mockResponse(200, { ...payload[0], mergeable: true, mergeable_state: 'clean' })),
  )
  const mergeReq = new utils.ObserveRequest()
  server.use(
    http.put(
      `${utils.api}/repos/Codertocat/Hello-World/pulls/2/merge`,
      utils.mockResponse(200, null, mergeReq),
    ),
  )
  return mergeReq
}

function countMerges() {
  let merges = 0
  server.use(http.put(`${utils.api}/repos/Codertocat/Hello-World/pulls/2/merge`, () => {
    merges++
    return new Response(JSON.stringify({ merged: true }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  }))
  return () => merges
}

describe('handleCronJobs', () => {
  it('fails when the job is not supported', async () => {
    utils.setupJobsEnv('not-a-job')
    const context = new utils.MockContext(pullReqOpenedEvent)

    const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})
    await expect(handleCronJobs(context)).resolves.toBeUndefined()
    expect(setFailed).toHaveBeenCalledTimes(1)
    expect(setFailed).toHaveBeenCalledWith(
      expect.stringContaining('could not execute not-a-job. May not be supported'),
    )
  })

  it('fails when no jobs are configured', async () => {
    utils.setupJobsEnv('')
    const context = new utils.MockContext(pullReqOpenedEvent)

    const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})
    await expect(handleCronJobs(context)).resolves.toBeUndefined()
    expect(setFailed).toHaveBeenCalledTimes(1)
    expect(setFailed).toHaveBeenCalledWith(
      expect.stringContaining('please provide a list of space delimited commands / jobs to run'),
    )
  })

  it('dispatches jobs delimited by newlines', async () => {
    utils.setupJobsEnv('lgtm\n')
    const context = new utils.MockContext(pullReqOpenedEvent)
    const mergeReq = serveMergeablePr()

    const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})
    await expect(handleCronJobs(context)).resolves.toBeUndefined()
    await expect(mergeReq.called()).resolves.toBe('called')
    expect(setFailed).not.toHaveBeenCalled()
  })

  it('fails the removed pr-labeler job with an unknown-job error', async () => {
    utils.setupJobsEnv('pr-labeler')
    const context = new utils.MockContext(pullReqOpenedEvent)

    const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})
    await expect(handleCronJobs(context)).resolves.toBeUndefined()
    expect(setFailed).toHaveBeenCalledTimes(1)
    expect(setFailed).toHaveBeenCalledWith(
      expect.stringContaining('could not execute pr-labeler. May not be supported'),
    )
  })

  it('dispatches jobs delimited by newlines and extra spaces', async () => {
    utils.setupJobsEnv('lgtm  pr-labeler\n')
    const context = new utils.MockContext(pullReqOpenedEvent)
    const mergeReq = serveMergeablePr()

    const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})
    await expect(handleCronJobs(context)).resolves.toBeUndefined()
    await expect(mergeReq.called()).resolves.toBe('called')
    expect(setFailed).toHaveBeenCalledWith(
      expect.stringContaining('could not execute pr-labeler'),
    )
  })

  it('jobs: sweep lgtm evaluates a pull request both jobs reach once, whichever runs first', async () => {
    utils.setupJobsEnv('sweep lgtm')
    const context = new utils.MockContext(pullReqOpenedEvent)
    serveMergeablePr({ updatedNow: true })
    const merges = countMerges()
    const info = vi.spyOn(core, 'info')

    const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})
    await expect(handleCronJobs(context)).resolves.toBeUndefined()
    expect(merges()).toBe(1)
    expect(info).toHaveBeenCalledWith('skipping pr #2: already evaluated in this run')
    expect(setFailed).not.toHaveBeenCalled()
  })

  it('matches job names case-insensitively', async () => {
    utils.setupJobsEnv('LGTM')
    const context = new utils.MockContext(pullReqOpenedEvent)
    const mergeReq = serveMergeablePr()

    const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})
    await expect(handleCronJobs(context)).resolves.toBeUndefined()
    await expect(mergeReq.called()).resolves.toBe('called')
    expect(setFailed).not.toHaveBeenCalled()
  })
})
