import type { WorkerOptions } from 'miniflare'
import { generateKeyPairSync } from 'node:crypto'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { sign } from '@octokit/webhooks-methods'
import { Miniflare } from 'miniflare'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { unstable_getMiniflareWorkerOptions, unstable_readConfig } from 'wrangler'

import issueCommentEvent from '../fixtures/issues/issueCommentEvent.json'

// wrangler.toml is what `wrangler deploy` ships, yet `wrangler deploy --dry-run` accepts a binding the
// Worker never reads, a read the file never binds, and a Durable Object with no migration. worker.test.ts
// spells its own miniflare bindings out, so it cannot see the file drift either. This suite reads the
// committed file through wrangler itself: statically against the names src/server/worker.ts dereferences
// and docs/github-app.md tells the operator to create, then by running the bundle under exactly the
// bindings the file declares.
const root = path.resolve(__dirname, '..', '..')
const configPath = path.join(root, 'wrangler.toml')
const workerSource = readFileSync(path.join(root, 'src/server/worker.ts'), 'utf8')
const settingsSource = readFileSync(path.join(root, 'src/adapters/app/settings.ts'), 'utf8')
const workersDoc = readFileSync(path.join(root, 'docs/github-app.md'), 'utf8')

/** the part of wrangler's miniflare translation this suite reads (wrangler's own types do not resolve from here) */
interface DeclaredBindings {
  bindings?: Record<string, unknown>
  kvNamespaces?: Record<string, unknown>
  queueProducers?: Record<string, { queueName: string }>
  queueConsumers?: Record<string, { deadLetterQueue?: string }>
  durableObjects?: Record<string, string | { className: string }>
  cronTriggers?: string[]
}
interface Migration { new_classes?: string[], new_sqlite_classes?: string[] }

const { workerOptions, main } = unstable_getMiniflareWorkerOptions(configPath) as unknown as { workerOptions: DeclaredBindings, main?: string }
const config = unstable_readConfig({ config: configPath }, { hideWarnings: true }) as unknown as { migrations: Migration[] }

const kvBindings = Object.keys(workerOptions.kvNamespaces ?? {})
const queueBindings = Object.keys(workerOptions.queueProducers ?? {})
const durableObjectBindings = Object.keys(workerOptions.durableObjects ?? {})
const resourceBindings = [...kvBindings, ...queueBindings, ...durableObjectBindings].sort()

/** upper-case names a source file mentions as `env.NAME` or `'NAME'` */
function names(source: string, pattern: RegExp): string[] {
  return [...new Set([...source.matchAll(pattern)].map(match => match[1]))].sort()
}

describe('wrangler.toml', () => {
  it('builds the Worker the tests bundle', () => {
    expect(main).toBe(path.join(root, 'src/server/worker.ts'))
  })

  it('binds exactly the resources src/server/worker.ts dereferences', () => {
    expect(resourceBindings).toEqual(names(workerSource, /\benv\.([A-Z][A-Z0-9_]*)\b/g))
  })

  it('sets and documents only variables settingsFromEnv reads', () => {
    const known = names(settingsSource, /(?:'|\benv\.)([A-Z][A-Z0-9_]+)\b/g)
    const configured = Object.keys(workerOptions.bindings ?? {})
    const commentedOut = names(readFileSync(configPath, 'utf8'), /^#\s*([A-Z][A-Z0-9_]+) = /gm)
    expect(configured.length).toBeGreaterThan(0)
    expect(commentedOut.length).toBeGreaterThan(0)
    expect(known).toEqual(expect.arrayContaining([...configured, ...commentedOut]))
  })

  it('consumes the queue its producer sends to', () => {
    const produced = Object.values(workerOptions.queueProducers ?? {}).map(producer => producer.queueName).sort()
    expect(produced.length).toBeGreaterThan(0)
    expect(Object.keys(workerOptions.queueConsumers ?? {}).sort()).toEqual(produced)
  })

  it('sends a message its consumer keeps failing to a dead-letter queue, not to nowhere', () => {
    const consumers = Object.values(workerOptions.queueConsumers ?? {})
    expect(consumers.length).toBeGreaterThan(0)
    expect(consumers.every(consumer => consumer.deadLetterQueue === 'prow-jobs-dlq')).toBe(true)
  })

  it('migrates every Durable Object class it binds', () => {
    const bound = Object.values(workerOptions.durableObjects ?? {}).map(binding => (typeof binding === 'string' ? binding : binding.className)).sort()
    const migrated = config.migrations.flatMap(migration => [...migration.new_classes ?? [], ...migration.new_sqlite_classes ?? []]).sort()
    expect(bound.length).toBeGreaterThan(0)
    expect(migrated).toEqual(bound)
  })

  it('triggers the scheduled handler the Worker exports', () => {
    expect(workerSource).toMatch(/^\s+async scheduled\(/m)
    expect(workerOptions.cronTriggers?.length).toBeGreaterThan(0)
  })

  it('is what docs/github-app.md tells the operator to create and set', () => {
    const setup = /```sh\n(npx wrangler kv namespace create [\s\S]*?)```/.exec(workersDoc)?.[1]
    expect(setup).toBeDefined()
    expect(names(setup!, /kv namespace create ([A-Z][A-Z0-9_]+)/g)).toEqual(kvBindings.sort())
    expect(names(setup!, /queues create ([a-z][a-z0-9-]+)/g)).toEqual(Object.keys(workerOptions.queueConsumers ?? {}).sort())
    expect(names(setup!, /secret put ([A-Z][A-Z0-9_]+)/g)).toEqual(names(settingsSource, /required\(env, '([A-Z][A-Z0-9_]+)'\)/g))
  })
})

describe('the Worker under the bindings wrangler.toml declares', () => {
  const bundle = path.join(root, 'dist-worker/worker.js')
  const secret = 'config-secret'
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } })
  let mf: Miniflare

  const githubScript = `
export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    await env.LOG.put('seen:' + Date.now() + '-' + crypto.randomUUID(), url.pathname)
    if (url.pathname.endsWith('/access_tokens')) {
      return Response.json({ token: 'ghs_config', expires_at: new Date(Date.now() + 3600000).toISOString(), permissions: {}, repository_selection: 'all' }, { status: 201 })
    }
    return Response.json({ message: 'Not Found' }, { status: 404 })
  },
}`

  beforeAll(async () => {
    mf = new Miniflare({
      workers: [
        {
          ...(workerOptions as WorkerOptions),
          name: 'prow',
          modules: true,
          scriptPath: bundle,
          // the three `wrangler secret put` values; everything else is the file's own
          bindings: { ...workerOptions.bindings, GITHUB_APP_ID: '4242', GITHUB_APP_PRIVATE_KEY: privateKey, GITHUB_WEBHOOK_SECRET: secret },
          outboundService: 'github',
        },
        { name: 'github', modules: true, script: githubScript, kvNamespaces: ['LOG'] },
      ],
    })
    await mf.ready
  }, 60_000)
  afterAll(() => mf?.dispose())

  async function githubSaw(): Promise<string[]> {
    const log = await mf.getKVNamespace('LOG', 'github')
    const keys = (await log.list()).keys.map(key => key.name).sort()
    return Promise.all(keys.map(async key => (await log.get(key)) ?? ''))
  }

  async function deliver(id: string) {
    const payload = structuredClone(issueCommentEvent) as typeof issueCommentEvent & { installation?: { id: number } }
    payload.installation = { id: 7 }
    // edited comments succeed without commands configured in wrangler.toml; failed deliveries are forgotten
    payload.action = 'edited'
    payload.comment.body = 'no command here'
    const body = JSON.stringify(payload)
    return mf.dispatchFetch('https://prow.test/webhook', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-github-delivery': id, 'x-github-event': 'issue_comment', 'x-hub-signature-256': await sign(secret, body) },
      body,
    })
  }

  it('dedupes a redelivery through the KV namespace the file binds and runs it under the installation token', async () => {
    expect((await deliver('d-config')).status).toBe(202)
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline && (await githubSaw()).length === 0) {
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    // the Durable Object mints the token (the receiver that hands the delivery over mints none); nothing else is asked of GitHub
    expect([...new Set(await githubSaw())]).toEqual(['/app/installations/7/access_tokens'])

    const again = await deliver('d-config')
    expect(again.status).toBe(200)
    expect(await again.text()).toBe('already handled')

    const [kvBinding] = kvBindings
    const deliveries = await mf.getKVNamespace(kvBinding, 'prow')
    expect(await deliveries.get('delivery:d-config')).toBe('1')
  })
})
