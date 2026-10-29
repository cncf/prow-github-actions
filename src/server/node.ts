import type { Scheduler } from '../adapters/app/cron'
import type { DeliveryStore } from '../adapters/app/dedupe'
import type { WebhookReceiver } from '../adapters/app/webhook'
import process from 'node:process'
import { serve } from '@hono/node-server'

import { Hono } from 'hono'
import { appInstallationLister, runScheduledJobs } from '../adapters/app/cron'
import { memoryDeliveryStore } from '../adapters/app/dedupe'
import { appTokenSource } from '../adapters/app/platform'
import { asyncLocalScope } from '../adapters/app/scope'
import { settingsFromEnv } from '../adapters/app/settings'
import { receiveWebhook } from '../adapters/app/webhook'
import { handleCronJobs } from '../cronJobs/handleCronJob'
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

export function buildScheduler(receiver: WebhookReceiver): Scheduler {
  return {
    settings: receiver.settings,
    tokens: receiver.tokens,
    installations: appInstallationLister(receiver.settings, receiver.tokens),
    sink: receiver.sink,
    dispatch: handleCronJobs,
  }
}

/** `node dist-server/index.js cron`: run the scheduled jobs once for every installation and exit */
export async function runCronOnce(env: Record<string, string | undefined> = process.env): Promise<number> {
  installPlatformScope(asyncLocalScope())
  const report = await runScheduledJobs(buildScheduler(buildReceiver(env)))
  return report.failed.length === 0 ? 0 : 1
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
  // PROW_CRON_INTERVAL: run the scheduled jobs in-process every N minutes, for a single-container deployment
  const minutes = Number(env.PROW_CRON_INTERVAL ?? 0)
  const scheduler = buildScheduler(receiver)
  const timer = minutes > 0
    ? setInterval(() => {
        runScheduledJobs(scheduler).catch((error) => {
          receiver.sink({ level: 'error', event: 'schedule', message: error instanceof Error ? error.message : String(error) })
        })
      }, minutes * 60_000)
    : undefined
  return {
    ready,
    close: () => {
      clearInterval(timer)
      server.close()
    },
  }
}
