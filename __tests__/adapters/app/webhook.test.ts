import type { DeliveryStore } from '../../../src/adapters/app/dedupe'
import type { staticTokens } from './testApp'

import { describe, expect, it } from 'vitest'
import { memoryDeliveryStore } from '../../../src/adapters/app/dedupe'
import { receiveWebhook } from '../../../src/adapters/app/webhook'
import issueCommentEvent from '../../fixtures/issues/issueCommentEvent.json'
import { receiver, recordingSink, signedRequest, withInstallation } from './testApp'

const payload = withInstallation(issueCommentEvent)

describe('receiveWebhook', () => {
  it('accepts a signed delivery, responds before the handler runs, and dispatches a Context for it', async () => {
    const r = receiver()

    const { response, handled } = await receiveWebhook(r, await signedRequest('issue_comment', payload))

    expect(response.status).toBe(202)
    expect(r.backgrounded).toEqual([handled])
    await handled
    expect(r.dispatched).toHaveLength(1)
    expect(r.dispatched[0]).toMatchObject({ eventName: 'issue_comment', repo: { owner: 'Codertocat', repo: 'Hello-World' } })
    expect(r.dispatched[0]!.payload.installation).toEqual({ id: 7 })
    expect((r.tokens as ReturnType<typeof staticTokens>).requested).toEqual([7])
  })

  it('rejects a bad signature with 401 and dispatches nothing', async () => {
    const r = receiver()

    const { response, handled } = await receiveWebhook(r, await signedRequest('issue_comment', payload, { secret: 'wrong' }))

    expect(response.status).toBe(401)
    expect(handled).toBeUndefined()
    expect(r.dispatched).toEqual([])
  })

  it('rejects a missing signature with 401', async () => {
    const r = receiver()
    const request = await signedRequest('issue_comment', payload)
    request.headers.delete('x-hub-signature-256')

    expect((await receiveWebhook(r, request)).response.status).toBe(401)
  })

  it('rejects a request without the delivery headers with 400', async () => {
    const r = receiver()

    const { response } = await receiveWebhook(r, new Request('https://prow.example/webhook', { method: 'POST', body: '{}' }))

    expect(response.status).toBe(400)
  })

  it('rejects a signed body that is not json with 400', async () => {
    const r = receiver()

    const { response } = await receiveWebhook(r, await signedRequest('issue_comment', null, { body: '{not json' }))

    expect(response.status).toBe(400)
    expect(r.dispatched).toEqual([])
  })

  it('answers ping with 200 and never dispatches it', async () => {
    const r = receiver()

    const { response, handled } = await receiveWebhook(r, await signedRequest('ping', { zen: 'Keep it logically awesome.' }))

    expect(response.status).toBe(200)
    expect(handled).toBeUndefined()
    expect(r.dispatched).toEqual([])
  })

  it('handles a redelivered id once', async () => {
    const r = receiver()

    const first = await receiveWebhook(r, await signedRequest('issue_comment', payload, { id: 'same' }))
    await first.handled
    const second = await receiveWebhook(r, await signedRequest('issue_comment', payload, { id: 'same' }))

    expect(second.response.status).toBe(200)
    expect(second.handled).toBeUndefined()
    expect(r.dispatched).toHaveLength(1)
  })

  it('answers 401 "bad signature" to an empty body that carries a signature, instead of throwing', async () => {
    const r = receiver()

    const { response, handled } = await receiveWebhook(r, await signedRequest('issue_comment', null, { body: '', signature: 'sha256=00' }))

    expect(response.status).toBe(401)
    await expect(response.text()).resolves.toBe('bad signature')
    expect(handled).toBeUndefined()
  })

  it.each([
    ['without an installation', issueCommentEvent],
    ['without a repository', (({ repository: _repository, ...noRepo }) => noRepo)(payload)],
    ['whose body is json null', null],
  ])('answers 202 "ignored" to a delivery %s, logs it at info and never claims the id', async (_name, body) => {
    const { lines, sink } = recordingSink()
    const r = receiver({
      sink,
      deliveries: { seen: async () => {
        throw new Error('store must not be consulted')
      } },
    })

    const { response, handled } = await receiveWebhook(r, await signedRequest('installation', body, { id: 'app-event' }))

    expect(response.status).toBe(202)
    await expect(response.text()).resolves.toBe('ignored')
    expect(handled).toBeUndefined()
    expect(r.dispatched).toEqual([])
    expect(lines).toEqual([{ level: 'info', delivery: 'app-event', event: 'installation', message: 'ignored: no repository or installation' }])
  })

  it('refuses an unusable installation with 400 and frees the id it claimed, so a corrected redelivery is handled', async () => {
    const r = receiver()

    const broken = await receiveWebhook(r, await signedRequest('issue_comment', { ...payload, installation: { id: '7' } }, { id: 'fixable' }))
    expect(broken.response.status).toBe(400)

    const corrected = await receiveWebhook(r, await signedRequest('issue_comment', payload, { id: 'fixable' }))
    expect(corrected.response.status).toBe(202)
    await corrected.handled
    expect(r.dispatched).toHaveLength(1)
  })

  it('records a handled delivery as done and a failed one as forgotten, so only the failed one runs again on redelivery', async () => {
    const steps: string[] = []
    const store = memoryDeliveryStore()
    const deliveries: DeliveryStore = {
      seen: store.seen,
      done: async (id) => {
        steps.push(`done ${id}`)
      },
      forget: async (id) => {
        steps.push(`forget ${id}`)
        await store.forget!(id)
      },
    }
    const r = receiver({
      deliveries,
      dispatch: async (context) => {
        if (context.payload.comment?.body === 'fail') {
          throw new Error('handler blew up')
        }
      },
    })
    const failing = structuredClone(payload)
    failing.comment.body = 'fail'

    await (await receiveWebhook(r, await signedRequest('issue_comment', payload, { id: 'ok' }))).handled
    await (await receiveWebhook(r, await signedRequest('issue_comment', failing, { id: 'bad' }))).handled

    expect(steps).toEqual(['done ok', 'forget bad'])
    expect((await receiveWebhook(r, await signedRequest('issue_comment', payload, { id: 'ok' }))).response.status).toBe(200)
    expect((await receiveWebhook(r, await signedRequest('issue_comment', payload, { id: 'bad' }))).response.status).toBe(202)
  })

  it('handles a delivery with a store that records neither outcome', async () => {
    const r = receiver({ deliveries: { seen: async () => false } })

    const { handled } = await receiveWebhook(r, await signedRequest('issue_comment', payload))

    await expect(handled).resolves.toBeUndefined()
    expect(r.dispatched).toHaveLength(1)
  })

  it('logs a store that cannot record the outcome, and never rejects the handled promise', async () => {
    const { lines, sink } = recordingSink()
    const r = receiver({
      sink,
      deliveries: {
        seen: async () => false,
        done: async () => {
          throw new Error('redis is down')
        },
        // eslint-disable-next-line prefer-promise-reject-errors
        forget: () => Promise.reject('offline'),
      },
    })

    await expect((await receiveWebhook(r, await signedRequest('issue_comment', payload, { id: 'a' }))).handled).resolves.toBeUndefined()
    await receiveWebhook(r, await signedRequest('issue_comment', { ...payload, installation: { id: '7' } }, { id: 'b' }))

    expect(lines).toContainEqual({ level: 'error', delivery: 'a', message: 'delivery store: done failed: redis is down' })
    expect(lines).toContainEqual({ level: 'error', delivery: 'b', message: 'delivery store: forget failed: offline' })
  })

  it('turns a handler rejection into fail() and a logged error, not an unhandled rejection', async () => {
    const lines: Record<string, unknown>[] = []
    const r = receiver({
      sink: line => lines.push(line),
      dispatch: async () => {
        throw new Error('handler blew up')
      },
    })

    const { handled } = await receiveWebhook(r, await signedRequest('issue_comment', payload))
    await expect(handled).resolves.toBeUndefined()

    expect(lines).toContainEqual(expect.objectContaining({ level: 'error', delivery: 'delivery-1', event: 'issue_comment', repo: 'Codertocat/Hello-World', message: 'handler blew up' }))
  })

  it('stringifies a non-Error rejection from the handler', async () => {
    const lines: Record<string, unknown>[] = []
    const r = receiver({
      sink: line => lines.push(line),
      // eslint-disable-next-line prefer-promise-reject-errors
      dispatch: () => Promise.reject('offline'),
    })

    await (await receiveWebhook(r, await signedRequest('issue_comment', payload))).handled

    expect(lines).toContainEqual(expect.objectContaining({ level: 'error', message: 'offline' }))
  })

  it('turns a token failure into fail()', async () => {
    const lines: Record<string, unknown>[] = []
    const r = receiver({
      sink: line => lines.push(line),
      tokens: { installationToken: async () => {
        throw new Error('app is suspended')
      } },
    })

    const { handled } = await receiveWebhook(r, await signedRequest('issue_comment', payload))
    await handled

    expect(r.dispatched).toEqual([])
    expect(lines).toContainEqual(expect.objectContaining({ level: 'error', message: 'app is suspended' }))
  })
})
