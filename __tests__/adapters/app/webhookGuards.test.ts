import { describe, expect, it } from 'vitest'

import { memoryDeliveryStore } from '../../../src/adapters/app/dedupe'
import { settingsFromEnv } from '../../../src/adapters/app/settings'
import { receiveWebhook } from '../../../src/adapters/app/webhook'
import issueCommentEvent from '../../fixtures/issues/issueCommentEvent.json'
import { receiver, signedRequest, withInstallation } from './testApp'

const payload = withInstallation(issueCommentEvent)

// Each case here fails under a mutant that the first round of adapter tests let
// through: a refusal whose body text or log line is not read, a header guard
// where `||` and `&&` behave the same once both headers are gone, and the two
// boundaries in dedupe.ts and settings.ts.
describe('receiveWebhook refusals name their reason', () => {
  it.each([
    ['x-github-delivery', 'the event header alone'],
    ['x-github-event', 'the delivery id alone'],
  ])('answers 400 "missing delivery headers" to %s and never reads the body or the store', async (missing) => {
    const r = receiver({
      deliveries: { seen: async () => {
        throw new Error('store must not be consulted')
      } },
    })
    const request = await signedRequest('issue_comment', payload)
    request.headers.delete(missing)

    const { response, handled } = await receiveWebhook(r, request)

    expect(response.status).toBe(400)
    await expect(response.text()).resolves.toBe('missing delivery headers')
    expect(handled).toBeUndefined()
    expect(request.bodyUsed).toBe(false)
    expect(r.dispatched).toEqual([])
  })

  it('answers 401 "bad signature", logs it at warning with the delivery and event, and never consults the store', async () => {
    const lines: Record<string, unknown>[] = []
    const r = receiver({
      sink: line => lines.push(line),
      deliveries: { seen: async () => {
        throw new Error('store must not be consulted')
      } },
    })

    const { response } = await receiveWebhook(r, await signedRequest('issue_comment', payload, { id: 'forged', secret: 'wrong' }))

    expect(response.status).toBe(401)
    await expect(response.text()).resolves.toBe('bad signature')
    expect(lines).toEqual([{ level: 'warning', delivery: 'forged', event: 'issue_comment', message: 'rejected: bad signature' }])
  })

  it('answers 400 "body is not json" and leaves the delivery id unconsumed so a corrected redelivery is handled', async () => {
    const r = receiver()

    const broken = await receiveWebhook(r, await signedRequest('issue_comment', null, { id: 'd-7', body: '{not json' }))
    await expect(broken.response.text()).resolves.toBe('body is not json')
    expect(broken.handled).toBeUndefined()

    const corrected = await receiveWebhook(r, await signedRequest('issue_comment', payload, { id: 'd-7' }))

    expect(corrected.response.status).toBe(202)
    await corrected.handled
    expect(r.dispatched).toHaveLength(1)
  })

  it('answers "pong" to ping and "accepted" to a dispatched delivery', async () => {
    const r = receiver()

    const ping = await receiveWebhook(r, await signedRequest('ping', { zen: 'Keep it logically awesome.' }))
    const accepted = await receiveWebhook(r, await signedRequest('issue_comment', payload))
    await accepted.handled

    await expect(ping.response.text()).resolves.toBe('pong')
    await expect(accepted.response.text()).resolves.toBe('accepted')
  })

  it('answers "already handled" to a redelivery and logs it at info with the delivery and event', async () => {
    const lines: Record<string, unknown>[] = []
    const r = receiver({ sink: line => lines.push(line) })

    await (await receiveWebhook(r, await signedRequest('issue_comment', payload, { id: 'again' }))).handled
    const { response } = await receiveWebhook(r, await signedRequest('issue_comment', payload, { id: 'again' }))

    await expect(response.text()).resolves.toBe('already handled')
    expect(lines).toContainEqual({ level: 'info', delivery: 'again', event: 'issue_comment', message: 'duplicate delivery ignored' })
  })
})

describe('memoryDeliveryStore at its capacity', () => {
  it('still remembers every id once exactly `capacity` ids are stored', async () => {
    const store = memoryDeliveryStore(2)

    await store.seen('a')
    await store.seen('b')

    expect(await store.seen('a')).toBe(true)
    expect(await store.seen('b')).toBe(true)
  })

  it('defaults to a capacity that keeps a redelivery recognised after many distinct ids', async () => {
    const store = memoryDeliveryStore()

    await store.seen('first')
    for (let i = 0; i < 9_999; i++) {
      await store.seen(`id-${i}`)
    }

    expect(await store.seen('first')).toBe(true)
  })
})

describe('settingsFromEnv input mapping', () => {
  const env = { GITHUB_APP_ID: '1', GITHUB_APP_PRIVATE_KEY: 'k', GITHUB_WEBHOOK_SECRET: 's' }

  it('omits an unset input rather than mapping it to undefined', () => {
    const s = settingsFromEnv({ ...env, PROW_JOBS: 'lgtm' })

    expect(s.inputs).toStrictEqual({ jobs: 'lgtm' })
    expect(Object.keys(s.inputs)).toEqual(['jobs'])
  })

  it('keeps an input that is set to the empty string', () => {
    const s = settingsFromEnv({ ...env, PROW_DRY_RUN: '' })

    expect(s.inputs).toStrictEqual({ 'dry-run': '' })
  })
})
