import { generateKeyPairSync } from 'node:crypto'
import path from 'node:path'
import { Miniflare } from 'miniflare'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// queue() in src/server/worker.ts walks the batch and acks or retries each message on its own, so one
// message's failure neither stops the ones behind it nor sends them round again. wrangler.toml delivers
// one message per batch and worker.test.ts runs under the same setting, so that loop is otherwise only
// ever driven with a single message. Here the same bundle runs under a two-message batch.
const bundle = path.resolve('dist-worker/worker.js')
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } })

interface Seen { path: string, auth: string | null }

// the fake GitHub: tokens name their installation, and installation 7's repository listing always fails
const githubScript = `
const log = (env, entry) => env.LOG.put('seen:' + String(Date.now()).padStart(15, '0') + '-' + crypto.randomUUID(), JSON.stringify(entry))
export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    await log(env, { path: url.pathname, auth: request.headers.get('authorization') })
    const token = /^\\/api\\/v3\\/app\\/installations\\/(\\d+)\\/access_tokens$/.exec(url.pathname)
    if (token) {
      return Response.json({ token: 'ghs_' + token[1], expires_at: new Date(Date.now() + 3600000).toISOString(), permissions: {}, repository_selection: 'all' }, { status: 201 })
    }
    if (url.pathname.endsWith('/installation/repositories')) {
      if (request.headers.get('authorization') === 'token ghs_7') {
        return Response.json({ message: 'Server Error' }, { status: 500 })
      }
      return Response.json({ total_count: 0, repositories: [] })
    }
    return Response.json({ message: 'Not Found' }, { status: 404 })
  },
}`

describe('the queue consumer under a batch of two', () => {
  let mf: Miniflare
  beforeAll(async () => {
    mf = new Miniflare({
      workers: [
        {
          name: 'prow',
          modules: true,
          scriptPath: bundle,
          compatibilityDate: '2026-08-04',
          compatibilityFlags: ['nodejs_compat'],
          bindings: { GITHUB_APP_ID: '4242', GITHUB_APP_PRIVATE_KEY: privateKey, GITHUB_WEBHOOK_SECRET: 'batch-secret', GITHUB_API_URL: 'https://github.test/api/v3', PROW_JOBS: 'lgtm' },
          kvNamespaces: ['DELIVERIES'],
          queueProducers: { PROW_QUEUE: { queueName: 'prow-jobs' } },
          // two messages per batch and one retry: a retried message lists its repositories a second time
          queueConsumers: { 'prow-jobs': { maxBatchSize: 2, maxBatchTimeout: 0, maxRetries: 1 } },
          durableObjects: { PULL_REQUEST_LOCK: { className: 'PullRequestLock', useSQLite: true } },
          outboundService: 'github',
        },
        { name: 'github', modules: true, script: githubScript, kvNamespaces: ['LOG'] },
      ],
    })
    await mf.ready
  }, 60_000)
  afterAll(() => mf?.dispose())

  async function listings(): Promise<string[]> {
    const log = await mf.getKVNamespace('LOG', 'github')
    const keys = (await log.list({ prefix: 'seen:' })).keys.map(key => key.name).sort()
    const seen = await Promise.all(keys.map(async key => JSON.parse((await log.get(key))!) as Seen))
    return seen.filter(s => s.path === '/api/v3/installation/repositories').map(s => s.auth ?? '')
  }

  it('a message that fails is retried on its own: the one behind it in the batch still runs, and runs once', async () => {
    const queue = await mf.getQueueProducer<{ kind: 'schedule', installationId: number }>('PROW_QUEUE', 'prow')
    await queue.sendBatch([{ body: { kind: 'schedule', installationId: 7 } }, { body: { kind: 'schedule', installationId: 9 } }])

    const deadline = Date.now() + 10_000
    while (Date.now() < deadline && (await listings()).filter(auth => auth === 'token ghs_7').length < 2) {
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    await new Promise(resolve => setTimeout(resolve, 300))

    const seen = await listings()
    // installation 7 failed first and came round once more; installation 9, behind it, was listed by the
    // first invocation and acknowledged, so the retry did not carry it
    expect(seen[0]).toBe('token ghs_7')
    expect(seen.filter(auth => auth === 'token ghs_7')).toHaveLength(2)
    expect(seen.filter(auth => auth === 'token ghs_9')).toHaveLength(1)
  })
})
