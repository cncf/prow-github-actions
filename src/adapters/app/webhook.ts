import type { Context } from '../../platform'
import type { DeliveryStore } from './dedupe'
import type { Delivery, LogSink, TokenSource } from './platform'
import type { AppSettings } from './settings'
import { verify } from '@octokit/webhooks-methods'

import { runWithPlatform } from '../../platform'
import { appPlatform } from './platform'

export interface WebhookReceiver {
  settings: AppSettings
  tokens: TokenSource
  deliveries: DeliveryStore
  sink: LogSink
  /** the handler every accepted delivery runs; `run` from src/run.ts in production */
  dispatch: (context: Context) => Promise<void>
  /** how work continues after the response; Node lets the promise run, Workers need waitUntil */
  background: (work: Promise<void>) => void
}

export interface WebhookOutcome {
  response: Response
  /** resolves when the handler is done; undefined when the delivery was not accepted */
  handled?: Promise<void>
}

const headerDelivery = 'x-github-delivery'
const headerEvent = 'x-github-event'
const headerSignature = 'x-hub-signature-256'

export async function receiveWebhook(receiver: WebhookReceiver, request: Request): Promise<WebhookOutcome> {
  const id = request.headers.get(headerDelivery)
  const eventName = request.headers.get(headerEvent)
  const signature = request.headers.get(headerSignature)
  if (!id || !eventName) {
    return { response: new Response('missing delivery headers', { status: 400 }) }
  }
  const body = await request.text()
  if (!signature || !(await verify(receiver.settings.webhookSecret, body, signature))) {
    receiver.sink({ level: 'warning', delivery: id, event: eventName, message: 'rejected: bad signature' })
    return { response: new Response('bad signature', { status: 401 }) }
  }

  let payload: Context['payload']
  try {
    payload = JSON.parse(body) as Context['payload']
  }
  catch {
    return { response: new Response('body is not json', { status: 400 }) }
  }
  if (eventName === 'ping') {
    return { response: new Response('pong', { status: 200 }) }
  }
  if (await receiver.deliveries.seen(id)) {
    receiver.sink({ level: 'info', delivery: id, event: eventName, message: 'duplicate delivery ignored' })
    return { response: new Response('already handled', { status: 200 }) }
  }

  const delivery: Delivery = { id, eventName, payload }
  let run: ReturnType<typeof appPlatform>
  try {
    run = appPlatform(receiver.settings, receiver.tokens, delivery, receiver.sink)
  }
  catch (error) {
    receiver.sink({ level: 'warning', delivery: id, event: eventName, message: error instanceof Error ? error.message : String(error) })
    return { response: new Response('unusable delivery', { status: 400 }) }
  }

  const handled = (async () => {
    try {
      await run.resolveToken()
      await runWithPlatform(run.platform, () => receiver.dispatch(run.platform.context()))
    }
    catch (error) {
      run.platform.fail(error instanceof Error ? error.message : String(error))
    }
  })()
  receiver.background(handled)
  return { response: new Response('accepted', { status: 202 }), handled }
}
