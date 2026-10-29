import { describe, expect, it, vi } from 'vitest'

import { receiveWebhook } from '../../../src/adapters/app/webhook'
import issueCommentEvent from '../../fixtures/issues/issueCommentEvent.json'
import { receiver, recordingSink, signedRequest, withInstallation } from './testApp'

// appPlatform's own guards throw Error instances; this pins the arm that reports a
// thrown non-Error so the sink never sees "[object Object]" or an empty message
vi.mock('../../../src/adapters/app/platform', () => ({
  appPlatform: () => {
    // eslint-disable-next-line no-throw-literal
    throw 'not an error object'
  },
}))

describe('receiveWebhook when building the platform throws a non-Error', () => {
  it('answers 400 and logs the thrown value as the message', async () => {
    const { lines, sink } = recordingSink()
    const r = receiver({ sink })

    const { response, handled } = await receiveWebhook(r, await signedRequest('issue_comment', withInstallation(issueCommentEvent)))

    expect(response.status).toBe(400)
    expect(await response.text()).toBe('unusable delivery')
    expect(handled).toBeUndefined()
    expect(r.dispatched).toEqual([])
    expect(lines).toEqual([{ level: 'warning', delivery: 'delivery-1', event: 'issue_comment', message: 'not an error object' }])
  })
})
