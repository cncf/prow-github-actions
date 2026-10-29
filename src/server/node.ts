import type { DeliveryStore } from '../adapters/app/dedupe'
import type { WebhookReceiver } from '../adapters/app/webhook'
import process from 'node:process'
import { serve } from '@hono/node-server'
import { Hono } from 'hono'

import { memoryDeliveryStore } from '../adapters/app/dedupe'
import { appTokenSource } from '../adapters/app/platform'
import { asyncLocalScope } from '../adapters/app/scope'
import { settingsFromEnv } from '../adapters/app/settings'
import { receiveWebhook } from '../adapters/app/webhook'
import { installPlatformScope } from '../platform'
import { run } from '../run'

export function buildReceiver(env: Record<string, string | undefined>, deliveries: DeliveryStore = memoryDeliveryStore()): WebhookReceiver {
  const settings = settingsFromEnv(env)
  return {
    settings,
    tokens: appTokenSource(settings),
    deliveries,
    sink: line => process.stdout.write(`${JSON.stringify({ time: new Date().toISOString(), ...line })}\n`),
    dispatch: run,
    background: (work) => {
      void work
    },
  }
}

export function buildApp(receiver: WebhookReceiver): Hono {
  const app = new Hono()
  app.get('/healthz', c => c.text('ok'))
  app.post('/webhook', async (c) => {
    const { response } = await receiveWebhook(receiver, c.req.raw)
    return response
  })
  return app
}

export interface Listening {
  ready: Promise<void>
  close: () => void
}

export function main(env: Record<string, string | undefined> = process.env): Listening {
  installPlatformScope(asyncLocalScope())
  const receiver = buildReceiver(env)
  const port = Number(env.PORT ?? 8080)
  let resolveReady!: () => void
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve
  })
  const server = serve({ fetch: buildApp(receiver).fetch, port }, () => {
    receiver.sink({ level: 'info', message: `listening on :${port}` })
    resolveReady()
  })
  return { ready, close: () => server.close() }
}
