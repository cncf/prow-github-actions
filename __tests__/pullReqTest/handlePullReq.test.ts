import * as core from '@actions/core'
import { expect, it, vi } from 'vitest'
import { handlePullReq } from '../../src/pullReq/handlePullReq'

import prCreatedEvent from '../fixtures/pullReq/pullReqOpenedEvent.json'

import * as utils from '../testUtils'

it('ignores the jobs if not setup in environment', async () => {
  const spy = vi.spyOn(core, 'setFailed')

  utils.setupActionsEnv('/assign')

  const runContext = new utils.MockContext(prCreatedEvent)

  await handlePullReq(runContext)
  expect(spy).toHaveBeenCalled()
})
