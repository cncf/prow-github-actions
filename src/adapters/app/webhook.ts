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
  dispatch: (context: Context, delivery: Delivery) => Promise<void>
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
  // verify() throws on an empty body rather than answering false
  if (!signature || !body || !(await verify(receiver.settings.webhookSecret, body, signature))) {
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
  // installation, github_app_authorization and the like are about the App, not a repository: nothing here handles them
  if (!payload?.repository || payload.installation?.id === undefined) {
    receiver.sink({ level: 'info', delivery: id, event: eventName, message: 'ignored: no repository or installation' })
    return { response: new Response('ignored', { status: 202 }) }
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
    await forget(receiver, id)
    return { response: new Response('unusable delivery', { status: 400 }) }
  }

  const handled = (async () => {
    try {
      await run.resolveToken()
      await runWithPlatform(run.platform, () => receiver.dispatch(run.platform.context(), delivery))
    }
    catch (error) {
      run.platform.fail(error instanceof Error ? error.message : String(error))
    }
    // a delivery that failed is forgotten, so GitHub's redelivery runs it again; one that succeeded is remembered
    if (run.failures.length > 0) {
      await forget(receiver, id)
    }
    else {
      await settle(receiver, id, 'done', store => store.done?.(id))
    }
  })()
  receiver.background(handled)
  return { response: new Response('accepted', { status: 202 }), handled }
}

function forget(receiver: WebhookReceiver, id: string): Promise<void> {
  return settle(receiver, id, 'forget', store => store.forget?.(id))
}

/** records how a claimed delivery ended; a store that cannot is logged, never thrown, since the response is already sent */
async function settle(receiver: WebhookReceiver, id: string, step: string, record: (store: DeliveryStore) => Promise<void> | undefined): Promise<void> {
  try {
    await record(receiver.deliveries)
  }
  catch (error) {
    receiver.sink({ level: 'error', delivery: id, message: `delivery store: ${step} failed: ${error instanceof Error ? error.message : String(error)}` })
  }
}
