import type { DeliveryStore } from '../adapters/app/dedupe'
import type { DeferStrategy, Delivery, TokenSource } from '../adapters/app/platform'
import type { AppSettings } from '../adapters/app/settings'
import type { WebhookReceiver } from '../adapters/app/webhook'
import type { Deferred } from '../platform'
import { DurableObject } from 'cloudflare:workers'
import { Hono } from 'hono'

import { appInstallationLister, runScheduledJobs } from '../adapters/app/cron'
import { memoryLocks, pullRequestKey } from '../adapters/app/lock'
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

/**
 * what travels through the queue: a scheduled run for one installation, work
 * deferred from a delivery (whose context the consumer rebuilds from it), or a
 * delivery about no issue or pull request, which has no lock to run under
 */
export type QueueMessage
  = | { kind: 'schedule', installationId: number }
    | { kind: 'deferred', delivery: Delivery, deferred: Omit<Deferred, 'context'> }
    | { kind: 'delivery', delivery: Delivery }

// every handler, the Durable Object's included, runs its deliveries under this one scope; installing a new one per
// request would orphan the platform of every run still in flight in the isolate
installPlatformScope(asyncLocalScope())

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
 * `concurrency:` group does. A Durable Object alone does not: its input gate
 * closes only on storage, so a call that awaits a fetch to GitHub lets the next
 * one start. Every call therefore queues on one in-memory lock, which a single
 * object per pull request makes the pull request's lock.
 */
export class PullRequestLock extends DurableObject<Env> {
  private locks = memoryLocks()

  async handle(delivery: Delivery): Promise<void> {
    await this.locks.withLock('pull request', () => handleDelivery(this.env, delivery))
  }

  async resume(delivery: Delivery, deferred: Omit<Deferred, 'context'>): Promise<void> {
    await this.locks.withLock('pull request', () => handleDelivery(this.env, delivery, context => resumeDeferred({ ...deferred, context })))
  }
}

// Workers Logs capture every console method; `info` keeps the lines at their own level, apart from runtime errors
// eslint-disable-next-line no-console
const emit = (line: Record<string, unknown>): void => console.info(JSON.stringify(line))

function sinkFor(): (line: Record<string, unknown>) => void {
  return emit
}

// one token source per deployment, so an isolate reuses the installation tokens it has minted (auth-app caches them)
// instead of minting one per delivery
const tokenSources = new WeakMap<Env, TokenSource>()

function tokensFor(env: Env, settings: AppSettings): TokenSource {
  let tokens = tokenSources.get(env)
  if (tokens === undefined) {
    tokens = appTokenSource(settings)
    tokenSources.set(env, tokens)
  }
  return tokens
}

function deferViaQueue(env: Env, delivery: Delivery): DeferStrategy {
  return async (delayMs, resume) => {
    const { context: _context, ...deferred } = resume
    const message: QueueMessage = { kind: 'deferred', delivery, deferred }
    await env.PROW_QUEUE.send(message, { delaySeconds: Math.max(1, Math.ceil(delayMs / 1000)) })
    return 'deferred'
  }
}

/**
 * runs one delivery under its platform: the Durable Object and the queue
 * consumer both end here. A run that failed throws once its errors are logged,
 * so a queue message is retried and the webhook receiver sees the failure.
 */
export async function handleDelivery(env: Env, delivery: Delivery, work: (context: import('../platform').Context) => Promise<void> = run): Promise<void> {
  const settings = settingsFromEnv(env as unknown as Record<string, string | undefined>)
  const appRun = appPlatform(settings, tokensFor(env, settings), delivery, sinkFor(), deferViaQueue(env, delivery))
  try {
    await appRun.resolveToken()
    await runWithPlatform(appRun.platform, () => work(appRun.platform.context()))
  }
  catch (error) {
    appRun.platform.fail(error instanceof Error ? error.message : String(error))
  }
  if (appRun.failures.length > 0) {
    throw new Error(`${delivery.eventName} delivery ${delivery.id} failed; its errors are logged`)
  }
}

export function receiverFor(env: Env, waitUntil: (work: Promise<void>) => void): WebhookReceiver {
  const settings = settingsFromEnv(env as unknown as Record<string, string | undefined>)
  return {
    settings,
    tokens: tokensFor(env, settings),
    deliveries: kvDeliveryStore(env.DELIVERIES),
    sink: sinkFor(),
    // a pull request's events run one at a time inside its Durable Object; any other event runs from the queue,
    // which retries it. Either builds its own platform and mints its own token
    dispatch: async (_context, delivery) => {
      const key = pullRequestKey(delivery)
      if (key !== undefined) {
        await env.PULL_REQUEST_LOCK.getByName(key).handle(delivery)
        return
      }
      await env.PROW_QUEUE.send({ kind: 'delivery', delivery })
    },
    needsToken: () => false,
    background: waitUntil,
  }
}

const app = new Hono<{ Bindings: Env }>()
app.get('/healthz', c => c.text('ok'))
app.post('/webhook', async (c) => {
  const { response } = await receiveWebhook(receiverFor(c.env, work => c.executionCtx.waitUntil(work)), c.req.raw)
  return response
})

export default {
  fetch: app.fetch,

  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    const settings = settingsFromEnv(env as unknown as Record<string, string | undefined>)
    const lister = appInstallationLister(settings, tokensFor(env, settings), sinkFor())
    for await (const installationId of lister.installations()) {
      await env.PROW_QUEUE.send({ kind: 'schedule', installationId })
    }
  },

  async queue(batch: MessageBatch<QueueMessage>, env: Env): Promise<void> {
    const settings = settingsFromEnv(env as unknown as Record<string, string | undefined>)
    for (const message of batch.messages) {
      try {
        const body = message.body
        if (body.kind === 'schedule') {
          const tokens = tokensFor(env, settings)
          const lister = appInstallationLister(settings, tokens, sinkFor())
          const installation = { repositories: () => lister.repositoriesOf(body.installationId) }
          await runScheduledJobs({ settings, tokens, installations: installation, sink: sinkFor(), dispatch: handleCronJobs })
        }
        else if (body.kind === 'delivery') {
          await handleDelivery(env, body.delivery)
        }
        else {
          // the deferred check resumes under its pull request's lock, so it does not race that pull request's events
          const key = pullRequestKey(body.delivery)
          await (key === undefined
            ? handleDelivery(env, body.delivery, context => resumeDeferred({ ...body.deferred, context }))
            : env.PULL_REQUEST_LOCK.getByName(key).resume(body.delivery, body.deferred))
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
