import * as core from '@actions/core'
import { http } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest'
import { handlePullReq } from '../../src/pullReq/handlePullReq'

import issuePayload from '../fixtures/issues/issue.json'
import prCreatedEvent from '../fixtures/pullReq/pullReqOpenedEvent.json'

import * as utils from '../testUtils'

const server = setupServer()
beforeAll(() =>
  server.listen({
    onUnhandledRequest: 'error',
  }),
)
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

function serveLgtmRemoval() {
  const payload = structuredClone(issuePayload)
  payload.labels.push({ ...payload.labels[0], name: 'lgtm' })
  server.use(
    http.get(
      `${utils.api}/repos/Codertocat/Hello-World/issues/1`,
      utils.mockResponse(200, payload),
    ),
  )
  const deleteReq = new utils.ObserveRequest()
  server.use(
    http.delete(
      `${utils.api}/repos/Codertocat/Hello-World/issues/1/labels/lgtm`,
      utils.mockResponse(200, null, deleteReq),
    ),
  )
  return deleteReq
}

it('ignores the jobs if not setup in environment', async () => {
  const spy = vi.spyOn(core, 'setFailed')

  utils.setupActionsEnv('/assign')

  const runContext = new utils.MockContext(prCreatedEvent)

  await handlePullReq(runContext)
  expect(spy).toHaveBeenCalled()
})

it('dispatches jobs delimited by newlines', async () => {
  utils.setupJobsEnv('lgtm\n')
  const runContext = new utils.MockContext(prCreatedEvent)
  const deleteReq = serveLgtmRemoval()

  const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})
  await expect(handlePullReq(runContext)).resolves.toBeUndefined()
  await expect(deleteReq.called()).resolves.toBe('called')
  expect(setFailed).not.toHaveBeenCalled()
})

it('dispatches jobs delimited by newlines and extra spaces', async () => {
  utils.setupJobsEnv('lgtm  pr-labeler\n')
  const runContext = new utils.MockContext(prCreatedEvent)
  const deleteReq = serveLgtmRemoval()

  const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})
  await expect(handlePullReq(runContext)).resolves.toBeUndefined()
  await expect(deleteReq.called()).resolves.toBe('called')
  expect(setFailed).toHaveBeenCalledWith(
    expect.stringContaining('could not execute pr-labeler'),
  )
})

it('matches job names case-insensitively', async () => {
  utils.setupJobsEnv('LGTM')
  const runContext = new utils.MockContext(prCreatedEvent)
  const deleteReq = serveLgtmRemoval()

  const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})
  await expect(handlePullReq(runContext)).resolves.toBeUndefined()
  await expect(deleteReq.called()).resolves.toBe('called')
  expect(setFailed).not.toHaveBeenCalled()
})
