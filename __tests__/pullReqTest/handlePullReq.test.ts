import * as core from '@actions/core'
import { http } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { okToTestOnPullRequest } from '../../src/issueComment/trigger'
import { approveOnPullRequest } from '../../src/plugins/approve'
import { blunderbuss } from '../../src/plugins/blunderbuss'
import { lgtmOnPullRequest } from '../../src/plugins/lgtmBinding'
import { ownersLabel } from '../../src/plugins/ownersLabel'
import { requireMatchingLabel } from '../../src/plugins/requireMatchingLabel'
import { tideOnPullRequest } from '../../src/plugins/tide'
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
const registeredHandlers = [...pullRequestHandlers]
beforeEach(() => {
  pullRequestHandlers.length = 0
})
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

it('registers require-matching-label, owners-label, blunderbuss, lgtm, approve, ok-to-test and tide, in that order', () => {
  expect(registeredHandlers).toEqual([requireMatchingLabel, ownersLabel, blunderbuss, lgtmOnPullRequest, approveOnPullRequest, okToTestOnPullRequest, tideOnPullRequest])
})

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

it('fails when no jobs are configured and no pull_request handler is registered', async () => {
  const spy = vi.spyOn(core, 'setFailed').mockImplementation(() => {})

  utils.setupActionsEnv('/assign')

  const runContext = new utils.MockContext(prSynchronizeEvent)

  await handlePullReq(runContext)
  expect(spy).toHaveBeenCalledExactlyOnceWith('please provide a list of space delimited commands / jobs to run. None found')
})

it('does not fail when no jobs are configured but a pull_request handler is registered', async () => {
  const spy = vi.spyOn(core, 'setFailed').mockImplementation(() => {})
  const handler = vi.fn().mockResolvedValue(undefined)
  pullRequestHandlers.push(handler)

  utils.setupActionsEnv('/assign')

  const runContext = new utils.MockContext({ ...prOpenedEvent, action: 'labeled' })

  await handlePullReq(runContext)
  expect(handler).toHaveBeenCalledWith(runContext)
  expect(spy).not.toHaveBeenCalled()
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

it('runs the registered handlers one after the other in registration order', async () => {
  utils.setupActionsEnv('/assign')
  const runContext = new utils.MockContext({ ...prOpenedEvent, action: 'labeled' })
  const order: string[] = []
  pullRequestHandlers.push(
    async () => {
      order.push('first:start')
      await new Promise(resolve => setTimeout(resolve, 20))
      order.push('first:end')
    },
    async () => {
      order.push('second')
    },
  )

  await expect(handlePullReq(runContext)).resolves.toBeUndefined()
  expect(order).toEqual(['first:start', 'first:end', 'second'])
})

it('keeps running the later handlers when an earlier one rejects', async () => {
  utils.setupActionsEnv('/assign')
  const runContext = new utils.MockContext({ ...prOpenedEvent, action: 'labeled' })
  const later = vi.fn().mockResolvedValue(undefined)
  pullRequestHandlers.push(vi.fn().mockRejectedValue(new Error('plugin boom')), later)

  const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})
  await expect(handlePullReq(runContext)).resolves.toBeUndefined()
  expect(later).toHaveBeenCalledWith(runContext)
  expect(setFailed).toHaveBeenCalledWith('error handling pull_request event: plugin boom')
})

it('fails the run when a registered pull_request handler rejects', async () => {
  utils.setupJobsEnv('lgtm')
  const runContext = new utils.MockContext({ ...prOpenedEvent, action: 'labeled' })
  pullRequestHandlers.push(vi.fn().mockRejectedValue(new Error('plugin boom')))

  const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})
  await expect(handlePullReq(runContext)).resolves.toBeUndefined()
  expect(setFailed).toHaveBeenCalledWith('error handling pull_request event: plugin boom')
})

it.each(['synchronize', 'reopened'])('ok-to-test approves the pending runs of a labeled pull request on %s', async (action) => {
  utils.setupActionsEnv('/assign')
  const event = structuredClone(prOpenedEvent)
  event.action = action
  event.pull_request.labels.push({ name: 'ok-to-test' } as never)
  pullRequestHandlers.push(okToTestOnPullRequest)
  const approved: number[] = []
  server.use(
    http.get(`${utils.api}/repos/Codertocat/Hello-World/actions/runs`, ({ request }) => {
      expect(new URL(request.url).searchParams.get('head_sha')).toBe('ec26c3e57ca3a959ca5aad62de7213c562f8c821')
      return new Response(JSON.stringify({ total_count: 2, workflow_runs: [
        { id: 8, name: 'CI', path: '.github/workflows/ci.yml', status: 'action_required', conclusion: 'action_required' },
        { id: 2, name: 'Docs', path: '.github/workflows/docs.yml', status: 'completed', conclusion: 'success' },
      ] }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }),
    http.post(`${utils.api}/repos/Codertocat/Hello-World/actions/runs/:id/approve`, ({ params }) => {
      approved.push(Number(params.id))
      return new Response(null, { status: 201 })
    }),
  )
  const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})

  await expect(handlePullReq(new utils.MockContext(event))).resolves.toBeUndefined()

  expect(approved).toEqual([8])
  expect(setFailed).not.toHaveBeenCalled()
})

it.each(['synchronize', 'opened', 'labeled'])('ok-to-test makes no Actions call without the label on %s', async (action) => {
  utils.setupActionsEnv('/assign')
  pullRequestHandlers.push(okToTestOnPullRequest)
  const runs = new utils.ObserveRequest()
  server.use(http.get(`${utils.api}/repos/Codertocat/Hello-World/actions/runs`, utils.mockResponse(200, { total_count: 0, workflow_runs: [] }, runs)))

  await expect(handlePullReq(new utils.MockContext({ ...prOpenedEvent, action }))).resolves.toBeUndefined()

  await expect(runs.notCalled()).resolves.toBe('not called')
})
