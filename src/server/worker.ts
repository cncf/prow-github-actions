import type { DeliveryStore } from '../adapters/app/dedupe'
import type { DeferStrategy, Delivery } from '../adapters/app/platform'
import type { WebhookReceiver } from '../adapters/app/webhook'
import type { Deferred } from '../platform'
import { DurableObject } from 'cloudflare:workers'
import { Hono } from 'hono'

import { appInstallationLister, runScheduledJobs } from '../adapters/app/cron'
import { appPlatform, appTokenSource } from '../adapters/app/platform'
import { asyncLocalScope } from '../adapters/app/scope'
import { settingsFromEnv } from '../adapters/app/settings'
import { receiveWebhook } from '../adapters/app/webhook'
import { handleCronJobs } from '../cronJobs/handleCronJob'
import { resumeDeferred } from '../deferred'
import { installPlatformScope, runWithPlatform } from '../platform'
import { run } from '../run'

export interface Env {
  GITHUB_APP_ID: string
  GITHUB_APP_PRIVATE_KEY: string
  GITHUB_WEBHOOK_SECRET: string
  GITHUB_API_URL?: string
  PROW_COMMANDS?: string
  PROW_JOBS?: string
  PROW_MERGE_METHOD?: string
  PROW_CONFIG?: string
  PROW_DRY_RUN?: string
  CAT_API_KEY?: string
  DELIVERIES: KVNamespace
  PROW_QUEUE: Queue<QueueMessage>
  PULL_REQUEST_LOCK: DurableObjectNamespace<PullRequestLock>
}

/** what travels through the queue: a scheduled run for one installation, or deferred work */
export type QueueMessage
  = | { kind: 'schedule', installationId: number }
    | { kind: 'deferred', delivery: Delivery, deferred: Omit<Deferred, 'context'> & { payload: Delivery['payload'] } }

/** webhook delivery ids live in KV for a day; GitHub's redelivery button reaches back further, which is intended */
export function kvDeliveryStore(kv: KVNamespace): DeliveryStore {
  return {
    async seen(id) {
      const key = `delivery:${id}`
      if (await kv.get(key) !== null) {
        return true
      }
      await kv.put(key, '1', { expirationTtl: 86_400 })
      return false
    },
  }
}

/**
 * PullRequestLock serializes the events of one pull request, as the action's
 * `concurrency:` group does: a Durable Object runs one call at a time, so
 * events that arrive together run in order instead of racing the merge gate.
 */
export class PullRequestLock extends DurableObject<Env> {
  async handle(delivery: Delivery): Promise<void> {
    await handleDelivery(this.env, delivery)
  }
}

export function pullRequestKey(delivery: Delivery): string | undefined {
  const number: unknown = delivery.payload.pull_request?.number ?? delivery.payload.issue?.number
  const repository = delivery.payload.repository
  if (typeof number !== 'number' || !repository?.full_name) {
    return undefined
  }
  return `${repository.full_name}#${number}`
}

// Workers Logs capture every console method; `info` keeps the lines at their own level, apart from runtime errors
// eslint-disable-next-line no-console
const emit = (line: Record<string, unknown>): void => console.info(JSON.stringify(line))

function sinkFor(): (line: Record<string, unknown>) => void {
  return emit
}

function deferViaQueue(env: Env, delivery: Delivery): DeferStrategy {
  return async (delayMs, resume) => {
    const { context: _context, ...rest } = resume
    const message: QueueMessage = { kind: 'deferred', delivery, deferred: { ...rest, payload: delivery.payload } }
    await env.PROW_QUEUE.send(message, { delaySeconds: Math.max(1, Math.ceil(delayMs / 1000)) })
    return 'deferred'
  }
}

/** runs one delivery under its platform: the webhook path and the Durable Object both end here */
export async function handleDelivery(env: Env, delivery: Delivery, work: (context: import('../platform').Context) => Promise<void> = run): Promise<void> {
  const settings = settingsFromEnv(env as unknown as Record<string, string | undefined>)
  const appRun = appPlatform(settings, appTokenSource(settings), delivery, sinkFor(), deferViaQueue(env, delivery))
  try {
    await appRun.resolveToken()
    await runWithPlatform(appRun.platform, () => work(appRun.platform.context()))
  }
  catch (error) {
    appRun.platform.fail(error instanceof Error ? error.message : String(error))
  }
}

export function receiverFor(env: Env, waitUntil: (work: Promise<void>) => void): WebhookReceiver {
  const settings = settingsFromEnv(env as unknown as Record<string, string | undefined>)
  return {
    settings,
    tokens: appTokenSource(settings),
    deliveries: kvDeliveryStore(env.DELIVERIES),
    sink: sinkFor(),
    // a pull request's events run one at a time inside its Durable Object, which builds its own platform
    dispatch: async (_context, delivery) => {
      const key = pullRequestKey(delivery)
      if (key === undefined) {
        return handleDelivery(env, delivery)
      }
      await env.PULL_REQUEST_LOCK.getByName(key).handle(delivery)
    },
    background: waitUntil,
  }
}

const app = new Hono<{ Bindings: Env }>()
app.get('/healthz', c => c.text('ok'))
app.post('/webhook', async (c) => {
  installPlatformScope(asyncLocalScope())
  const { response } = await receiveWebhook(receiverFor(c.env, work => c.executionCtx.waitUntil(work)), c.req.raw)
  return response
})

export default {
  fetch: app.fetch,

  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    const settings = settingsFromEnv(env as unknown as Record<string, string | undefined>)
    const lister = appInstallationLister(settings, appTokenSource(settings))
    const seen = new Set<number>()
    for await (const target of lister.repositories()) {
      if (!seen.has(target.installationId)) {
        seen.add(target.installationId)
        await env.PROW_QUEUE.send({ kind: 'schedule', installationId: target.installationId })
      }
    }
  },

  async queue(batch: MessageBatch<QueueMessage>, env: Env): Promise<void> {
    installPlatformScope(asyncLocalScope())
    const settings = settingsFromEnv(env as unknown as Record<string, string | undefined>)
    for (const message of batch.messages) {
      try {
        if (message.body.kind === 'schedule') {
          const { installationId } = message.body
          const tokens = appTokenSource(settings)
          const all = appInstallationLister(settings, tokens)
          const one = {
            async* repositories() {
              for await (const target of all.repositories()) {
                if (target.installationId === installationId) {
                  yield target
                }
              }
            },
          }
          await runScheduledJobs({ settings, tokens, installations: one, sink: sinkFor(), dispatch: handleCronJobs })
        }
        else {
          const { delivery, deferred } = message.body
          await handleDelivery(env, delivery, context => resumeDeferred({ ...deferred, context }))
        }
        message.ack()
      }
      catch (error) {
        emit({ level: 'error', message: error instanceof Error ? error.message : String(error) })
        message.retry()
      }
    }
  },
} satisfies ExportedHandler<Env, QueueMessage>
