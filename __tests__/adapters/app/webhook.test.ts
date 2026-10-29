import { describe, expect, it } from 'vitest'

import { receiveWebhook } from '../../../src/adapters/app/webhook'
import issueCommentEvent from '../../fixtures/issues/issueCommentEvent.json'
import { receiver, signedRequest, withInstallation } from './testApp'

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
    expect((r.tokens as { requested: number[] }).requested).toEqual([7])
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

  it('refuses a delivery without an installation with 400', async () => {
    const r = receiver()

    const { response } = await receiveWebhook(r, await signedRequest('issue_comment', issueCommentEvent))

    expect(response.status).toBe(400)
    expect(r.dispatched).toEqual([])
  })

  it('refuses a delivery without a repository with 400', async () => {
    const r = receiver()
    const { repository: _repository, ...noRepo } = payload

    const { response } = await receiveWebhook(r, await signedRequest('issue_comment', noRepo))

    expect(response.status).toBe(400)
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
