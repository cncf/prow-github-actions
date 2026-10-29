import type { Octokit } from '@octokit/rest'

import { afterEach, describe, expect, it, vi } from 'vitest'

import { enqueue, enqueuedByBot, queueState } from '../../src/utils/mergeQueue'
import pullReqOpenedEvent from '../fixtures/pullReq/pullReqOpenedEvent.json'

import * as utils from '../testUtils'

// Guards of src/utils/mergeQueue.ts that line coverage reaches but that no test
// in mergeQueue.test.ts would notice changing. This file deliberately does not
// call setupActionsEnv() or newRun(): the once-per-run warning is pinned on
// a platform instance nothing has replaced.

const context = new utils.MockContext(pullReqOpenedEvent)
const state = { pullRequestId: 'PR_kwDOtest', headOid: 'headsha', enabled: true, inQueue: false }

function rejectingWith(reason: unknown): Octokit {
  return { graphql: vi.fn().mockRejectedValue(reason) } as unknown as Octokit
}

afterEach(() => vi.resetModules())

describe('errorMessage', () => {
  it('reports a null rejection of the state query as "null" instead of throwing', async () => {
    const core = await import('@actions/core')

    await expect(queueState(rejectingWith(null), context, 7)).resolves.toBeUndefined()

    expect(core.warning).toHaveBeenCalledWith('could not read the merge queue state of pr #7; falling back to a direct merge: null')
  })

  it('classifies an undefined rejection of the enqueue mutation as other with the message "undefined"', async () => {
    await expect(enqueue(rejectingWith(undefined), context, state, 'headsha')).resolves.toEqual({ ok: false, message: 'undefined', kind: 'other' })
  })

  it('does not treat an errors property that is not an array as GraphQL errors', async () => {
    await expect(enqueue(rejectingWith({ errors: 'not an array' }), context, state, 'headsha')).resolves.toEqual({ ok: false, message: '[object Object]', kind: 'other' })
  })
})

describe('queueState warning', () => {
  it('warns on the first failure of a run without any reset having happened', async () => {
    const [core, fresh, freshPlatform, adapter] = await Promise.all([import('@actions/core'), import('../../src/utils/mergeQueue'), import('../../src/platform'), import('../../src/adapters/actions')])
    freshPlatform.setPlatform(adapter.actionsPlatform())
    vi.mocked(core.warning).mockClear()

    await expect(fresh.queueState(rejectingWith(new Error('first failure')), context, 7)).resolves.toBeUndefined()
    await expect(fresh.queueState(rejectingWith(new Error('second failure')), context, 8)).resolves.toBeUndefined()

    expect(core.warning).toHaveBeenCalledTimes(1)
    expect(core.warning).toHaveBeenCalledWith(expect.stringContaining('pr #7; falling back to a direct merge: first failure'))
  })
})

describe('enqueuedByBot', () => {
  it.each([
    ['dependabot[bot]-fan', false],
    ['[bot]renovate', false],
    ['github-actions[bot]', true],
  ])('%s -> %s: [bot] counts only as a suffix', (login, expected) => {
    expect(enqueuedByBot({ state: 'QUEUED', position: 1, enqueuer: login })).toBe(expected)
  })
})
