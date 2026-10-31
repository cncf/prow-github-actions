import type { Scheduler } from '../adapters/app/cron'
import type { DeliveryStore } from '../adapters/app/dedupe'
import type { PullRequestLocks } from '../adapters/app/lock'
import type { LogSink } from '../adapters/app/platform'
import type { WebhookReceiver } from '../adapters/app/webhook'
import process from 'node:process'
import { serve } from '@hono/node-server'

import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { createClient } from 'redis'
import { appInstallationLister, runScheduledJobs } from '../adapters/app/cron'
import { memoryDeliveryStore } from '../adapters/app/dedupe'
import { memoryLocks, pullRequestKey } from '../adapters/app/lock'
import { appTokenSource } from '../adapters/app/platform'
import { redisDeliveryStore, redisLocks } from '../adapters/app/redis'
import { asyncLocalScope } from '../adapters/app/scope'
import { settingsFromEnv } from '../adapters/app/settings'
import { receiveWebhook } from '../adapters/app/webhook'
import { handleCronJobs } from '../cronJobs/handleCronJob'
import { installPlatformScope } from '../platform'
import { run } from '../run'

/** what the replicas of a deployment share: nothing (one replica) or a Redis */
export interface Stores {
  deliveries: DeliveryStore
  locks: PullRequestLocks
  /** resolves once the backing service answers; readiness waits on it */
  ready: Promise<void>
  /** whether the backing service answers right now; readiness is 503 while it does not */
  connected: () => boolean
  close: () => Promise<void>
}

export function memoryStores(): Stores {
  return { deliveries: memoryDeliveryStore(), locks: memoryLocks(), ready: Promise.resolve(), connected: () => true, close: async () => {} }
}

export function redisStores(url: string, sink: LogSink): Stores {
  // without the offline queue a command fails at once while redis is down, instead of waiting for it to return
  const client = createClient({ url, disableOfflineQueue: true })
  client.on('error', (error: unknown) => sink({ level: 'error', message: `redis: ${error instanceof Error ? error.message : String(error)}` }))
  const ready = client.connect().then(() => {
    sink({ level: 'info', message: 'redis: connected' })
  })
  return {
    deliveries: redisDeliveryStore(client),
    locks: redisLocks(client, { sink }),
    ready,
    connected: () => client.isReady,
    close: async () => {
      await client.close()
    },
  }
}

/**
 * storesFromEnv picks the shared stores: REDIS_URL set means every replica
 * shares deliveries and locks through it; unset means this process is on its
 * own, which is only right for a single replica.
 */
export function storesFromEnv(env: Record<string, string | undefined>, sink: LogSink): Stores {
  if (env.REDIS_URL) {
    return redisStores(env.REDIS_URL, sink)
  }
  if (Number(env.PROW_REPLICAS ?? 1) > 1) {
    sink({ level: 'warning', message: `PROW_REPLICAS=${env.PROW_REPLICAS} without REDIS_URL: replicas will handle redeliveries twice and race on a pull request; set REDIS_URL` })
  }
  return memoryStores()
}

export function jsonStdoutSink(): LogSink {
  return line => process.stdout.write(`${JSON.stringify({ time: new Date().toISOString(), ...line })}\n`)
}

export interface Receiver extends WebhookReceiver {
  /** every accepted delivery still being handled; drained on shutdown */
  inFlight: Set<Promise<void>>
}

export function buildReceiver(env: Record<string, string | undefined>, stores: Stores = memoryStores(), sink: LogSink = jsonStdoutSink()): Receiver {
  const settings = settingsFromEnv(env)
  const inFlight = new Set<Promise<void>>()
  return {
    settings,
    tokens: appTokenSource(settings),
    deliveries: stores.deliveries,
    sink,
    inFlight,
    // an event about no issue or pull request has nothing to serialize against, as in the Worker
    dispatch: (context, delivery) => {
      const key = pullRequestKey(delivery)
      return key === undefined ? run(context) : stores.locks.withLock(key, () => run(context))
    },
    background: (work) => {
      inFlight.add(work)
      void work.finally(() => inFlight.delete(work))
    },
  }
}

export function buildScheduler(receiver: WebhookReceiver): Scheduler {
  return {
    settings: receiver.settings,
    tokens: receiver.tokens,
    installations: appInstallationLister(receiver.settings, receiver.tokens, receiver.sink),
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

/** GitHub caps a webhook payload at 25 MB and drops anything larger, so nothing above it is a real delivery */
export const maxWebhookBytes = 25 * 1024 * 1024

export function buildApp(receiver: WebhookReceiver, stores: Stores = memoryStores(), draining: () => boolean = () => false): Hono {
  const app = new Hono()
  let storesReady = false
  stores.ready.then(() => {
    storesReady = true
  }, () => {})
  app.get('/healthz', c => c.text('ok'))
  app.get('/readyz', (c) => {
    if (draining()) {
      return c.text('shutting down', 503)
    }
    return storesReady && stores.connected() ? c.text('ok') : c.text('stores not ready', 503)
  })
  app.post('/webhook', bodyLimit({ maxSize: maxWebhookBytes, onError: c => c.text('payload too large', 413) }), async (c) => {
    const { response } = await receiveWebhook(receiver, c.req.raw)
    return response
  })
  return app
}

export interface Listening {
  ready: Promise<void>
  /** stop listening, let in-flight deliveries finish (bounded by graceMs), close the stores */
  close: (graceMs?: number) => Promise<void>
}

export function main(env: Record<string, string | undefined> = process.env, signals: NodeJS.Process = process): Listening {
  installPlatformScope(asyncLocalScope())
  const sink = jsonStdoutSink()
  const stores = storesFromEnv(env, sink)
  const receiver = buildReceiver(env, stores, sink)
  const port = Number(env.PORT ?? 8080)
  let resolveReady!: () => void
  const ready = new Promise<void>((resolve) => {
    resolveReady = resolve
  })
  let draining = false
  const server = serve({ fetch: buildApp(receiver, stores, () => draining).fetch, port }, () => {
    sink({ level: 'info', message: `listening on :${port}` })
    resolveReady()
  })
  // PROW_CRON_INTERVAL: run the scheduled jobs in-process every N minutes, for a single-container deployment
  const minutes = Number(env.PROW_CRON_INTERVAL ?? 0)
  const scheduler = buildScheduler(receiver)
  // a run that outlasts the interval is not started again on top of itself
  let running = false
  const timer = minutes > 0
    ? setInterval(() => {
        if (running) {
          sink({ level: 'info', event: 'schedule', message: 'the previous scheduled run is still going; skipping this one' })
          return
        }
        running = true
        runScheduledJobs(scheduler).catch((error) => {
          sink({ level: 'error', event: 'schedule', message: error instanceof Error ? error.message : String(error) })
        }).finally(() => {
          running = false
        })
      }, minutes * 60_000)
    : undefined

  let closing: Promise<void> | undefined
  const close = (graceMs = Number(env.PROW_SHUTDOWN_GRACE_MS ?? 25_000)): Promise<void> => {
    closing ??= (async () => {
      clearInterval(timer)
      server.close()
      const pending = receiver.inFlight.size
      if (pending > 0) {
        sink({ level: 'info', message: `shutting down: waiting up to ${graceMs}ms for ${pending} in-flight deliveries` })
        await Promise.race([Promise.allSettled([...receiver.inFlight]), new Promise(resolve => setTimeout(resolve, graceMs))])
      }
      await stores.close()
      sink({ level: 'info', message: 'shut down' })
    })()
    return closing
  }
  // after SIGTERM the server keeps serving for PROW_SHUTDOWN_DRAIN_MS with /readyz at 503,
  // so the endpoints drop the pod before it stops accepting what is still routed to it
  const drainMs = Number(env.PROW_SHUTDOWN_DRAIN_MS ?? 5_000)
  const onSignal = (): void => {
    draining = true
    sink({ level: 'info', message: `shutting down: not ready, serving for ${drainMs}ms more` })
    setTimeout(() => {
      close().then(() => signals.exit(0), () => signals.exit(1))
    }, drainMs)
  }
  signals.once('SIGTERM', onSignal)
  signals.once('SIGINT', onSignal)

  return { ready, close }
}
