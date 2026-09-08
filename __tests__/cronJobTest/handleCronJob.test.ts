import * as core from '@actions/core'
import { describe, expect, it, vi } from 'vitest'

import { handleCronJobs } from '../../src/cronJobs/handleCronJob'
import pullReqOpenedEvent from '../fixtures/pullReq/pullReqOpenedEvent.json'

import * as utils from '../testUtils'

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
})
