import * as core from '@actions/core'
import { http } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest'
import { handlePullReq, pullRequestHandlers } from '../../src/pullReq/handlePullReq'

import issuePayload from '../fixtures/issues/issue.json'
import prOpenedEvent from '../fixtures/pullReq/pullReqOpenedEvent.json'

import * as utils from '../testUtils'

const server = setupServer()
beforeAll(() =>
  server.listen({
    onUnhandledRequest: 'error',
  }),
)
afterEach(() => {
  server.resetHandlers()
  pullRequestHandlers.length = 0
})
afterAll(() => server.close())

// the lgtm PR job only acts on new commits; the fixture is an `opened` event
const prSynchronizeEvent = { ...prOpenedEvent, action: 'synchronize' }

function serveLgtmRemoval() {
  const payload = structuredClone(issuePayload)
  payload.labels.push({ ...payload.labels[0], name: 'lgtm' })
  const getReq = new utils.ObserveRequest()
  server.use(
    http.get(
      `${utils.api}/repos/Codertocat/Hello-World/issues/1`,
      utils.mockResponse(200, payload, getReq),
    ),
  )
  const deleteReq = new utils.ObserveRequest()
  server.use(
    http.delete(
      `${utils.api}/repos/Codertocat/Hello-World/issues/1/labels/lgtm`,
      utils.mockResponse(200, null, deleteReq),
    ),
  )
  return { getReq, deleteReq }
}

it('ignores the jobs if not setup in environment', async () => {
  const spy = vi.spyOn(core, 'setFailed')

  utils.setupActionsEnv('/assign')

  const runContext = new utils.MockContext(prSynchronizeEvent)

  await handlePullReq(runContext)
  expect(spy).toHaveBeenCalled()
})

it('dispatches jobs delimited by newlines', async () => {
  utils.setupJobsEnv('lgtm\n')
  const runContext = new utils.MockContext(prSynchronizeEvent)
  const { deleteReq } = serveLgtmRemoval()

  const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})
  await expect(handlePullReq(runContext)).resolves.toBeUndefined()
  await expect(deleteReq.called()).resolves.toBe('called')
  expect(setFailed).not.toHaveBeenCalled()
})

it('dispatches jobs delimited by newlines and extra spaces', async () => {
  utils.setupJobsEnv('lgtm  pr-labeler\n')
  const runContext = new utils.MockContext(prSynchronizeEvent)
  const { deleteReq } = serveLgtmRemoval()

  const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})
  await expect(handlePullReq(runContext)).resolves.toBeUndefined()
  await expect(deleteReq.called()).resolves.toBe('called')
  expect(setFailed).toHaveBeenCalledWith(
    expect.stringContaining('could not execute pr-labeler'),
  )
})

it('matches job names case-insensitively', async () => {
  utils.setupJobsEnv('LGTM')
  const runContext = new utils.MockContext(prSynchronizeEvent)
  const { deleteReq } = serveLgtmRemoval()

  const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})
  await expect(handlePullReq(runContext)).resolves.toBeUndefined()
  await expect(deleteReq.called()).resolves.toBe('called')
  expect(setFailed).not.toHaveBeenCalled()
})

it.each(['opened', 'reopened', 'labeled', 'unlabeled', 'ready_for_review', 'edited', 'closed'])(
  'lgtm job does not touch the pr on a %s action',
  async (action) => {
    utils.setupJobsEnv('lgtm')
    const runContext = new utils.MockContext({ ...prOpenedEvent, action })
    const { getReq, deleteReq } = serveLgtmRemoval()

    const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})
    await expect(handlePullReq(runContext)).resolves.toBeUndefined()
    await expect(deleteReq.notCalled()).resolves.toBe('not called')
    expect(getReq.ref).toBeNull()
    expect(setFailed).not.toHaveBeenCalled()
  },
)

it('still fails on an unknown job name when the lgtm job is skipped', async () => {
  utils.setupJobsEnv('lgtm pr-labeler')
  const runContext = new utils.MockContext({ ...prOpenedEvent, action: 'labeled' })
  const { deleteReq } = serveLgtmRemoval()

  const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})
  await expect(handlePullReq(runContext)).resolves.toBeUndefined()
  await expect(deleteReq.notCalled()).resolves.toBe('not called')
  expect(setFailed).toHaveBeenCalledWith(
    expect.stringContaining('could not execute pr-labeler'),
  )
})

it('runs the registered pull_request handlers before the jobs', async () => {
  utils.setupJobsEnv('lgtm')
  const runContext = new utils.MockContext({ ...prOpenedEvent, action: 'labeled' })
  const handler = vi.fn().mockResolvedValue(undefined)
  pullRequestHandlers.push(handler)

  const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})
  await expect(handlePullReq(runContext)).resolves.toBeUndefined()
  expect(handler).toHaveBeenCalledWith(runContext)
  expect(setFailed).not.toHaveBeenCalled()
})

it('fails the run when a registered pull_request handler rejects', async () => {
  utils.setupJobsEnv('lgtm')
  const runContext = new utils.MockContext({ ...prOpenedEvent, action: 'labeled' })
  pullRequestHandlers.push(vi.fn().mockRejectedValue(new Error('plugin boom')))

  const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})
  await expect(handlePullReq(runContext)).resolves.toBeUndefined()
  expect(setFailed).toHaveBeenCalledWith('error handling pull_request event: plugin boom')
})
