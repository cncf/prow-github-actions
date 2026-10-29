import { generateKeyPairSync } from 'node:crypto'
import path from 'node:path'
import { sign } from '@octokit/webhooks-methods'
import { Miniflare } from 'miniflare'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import issueCommentEvent from '../fixtures/issues/issueCommentEvent.json'

// Runs the bundle `wrangler deploy --dry-run --outdir dist-worker` produced (npm run pack:worker, or globalSetup.ts)
// inside workerd with KV, a Queue and the Durable Object, so this is the Worker as deployed.
// GitHub is a fake served by a second miniflare worker the first one's fetch is routed to.
const bundle = path.resolve('dist-worker/worker.js')
const secret = 'worker-secret'
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } })

interface Seen { method: string, path: string, auth: string | null, body: string }

const githubScript = `
export default {
  async fetch(request, env) {
    const url = new URL(request.url)
    const body = await request.text()
    const seen = JSON.parse((await env.LOG.get('seen')) ?? '[]')
    seen.push({ method: request.method, path: url.pathname, auth: request.headers.get('authorization'), body })
    await env.LOG.put('seen', JSON.stringify(seen))
    if (url.pathname.endsWith('/access_tokens')) {
      return Response.json({ token: 'ghs_worker', expires_at: new Date(Date.now() + 3600000).toISOString(), permissions: {}, repository_selection: 'all' }, { status: 201 })
    }
    if (url.pathname.endsWith('/collaborators/Codertocat')) {
      return new Response(null, { status: 204 })
    }
    if (request.method === 'PATCH' && url.pathname.endsWith('/issues/1')) {
      return Response.json({})
    }
    return Response.json({ message: 'Not Found' }, { status: 404 })
  },
}`

describe('the Worker', () => {
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
          bindings: {
            GITHUB_APP_ID: '4242',
            GITHUB_APP_PRIVATE_KEY: privateKey,
            GITHUB_WEBHOOK_SECRET: secret,
            GITHUB_API_URL: 'https://github.test/api/v3',
            PROW_COMMANDS: '/close',
            PROW_JOBS: 'lgtm',
          },
          kvNamespaces: ['DELIVERIES'],
          queueProducers: { PROW_QUEUE: { queueName: 'prow-jobs' } },
          queueConsumers: { 'prow-jobs': { maxBatchSize: 1, maxBatchTimeout: 0, maxRetries: 0 } },
          durableObjects: { PULL_REQUEST_LOCK: { className: 'PullRequestLock', useSQLite: true } },
          outboundService: 'github',
        },
        {
          name: 'github',
          modules: true,
          script: githubScript,
          kvNamespaces: ['LOG'],
        },
      ],
    })
    await mf.ready
  }, 60_000)

  afterEach(async () => {
    const log = await mf.getKVNamespace('LOG', 'github')
    await log.delete('seen')
    const deliveries = await mf.getKVNamespace('DELIVERIES', 'prow')
    for (const key of (await deliveries.list()).keys) {
      await deliveries.delete(key.name)
    }
  })
  afterAll(() => mf?.dispose())

  async function githubSaw(): Promise<Seen[]> {
    const log = await mf.getKVNamespace('LOG', 'github')
    return JSON.parse((await log.get('seen')) ?? '[]') as Seen[]
  }

  async function deliver(eventName: string, payload: unknown, id = crypto.randomUUID(), useSecret = secret) {
    const body = JSON.stringify(payload)
    return mf.dispatchFetch('https://prow.test/webhook', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-github-delivery': id, 'x-github-event': eventName, 'x-hub-signature-256': await sign(useSecret, body) },
      body,
    })
  }

  async function eventually(check: () => Promise<boolean>, ms = 10_000): Promise<void> {
    const deadline = Date.now() + ms
    while (Date.now() < deadline) {
      if (await check()) {
        return
      }
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    throw new Error('condition not met in time')
  }

  it('serves /healthz', async () => {
    const response = await mf.dispatchFetch('https://prow.test/healthz')
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('ok')
  })

  it('rejects a bad signature', async () => {
    const response = await deliver('issue_comment', issueCommentEvent, 'd-bad', 'wrong')
    expect(response.status).toBe(401)
  })

  it('closes the issue /close names: token minted with the app jwt on the GHES url, then PATCH with it, through the pull request lock', async () => {
    const payload = structuredClone(issueCommentEvent) as typeof issueCommentEvent & { installation?: { id: number } }
    payload.installation = { id: 7 }
    payload.comment.body = '/close'

    const response = await deliver('issue_comment', payload, 'd-close')
    expect(response.status).toBe(202)

    await eventually(async () => (await githubSaw()).some(s => s.method === 'PATCH'))
    const seen = await githubSaw()
    const token = seen.find(s => s.path.endsWith('/app/installations/7/access_tokens'))
    expect(token?.auth).toMatch(/^bearer ey/i)
    const patch = seen.find(s => s.method === 'PATCH')
    expect(patch?.path).toBe('/api/v3/repos/Codertocat/Hello-World/issues/1')
    expect(patch?.auth).toBe('token ghs_worker')
    expect(JSON.parse(patch!.body)).toEqual({ state: 'closed' })
  })

  it('handles a redelivered id once, remembering it in KV', async () => {
    const payload = structuredClone(issueCommentEvent) as typeof issueCommentEvent & { installation?: { id: number } }
    payload.installation = { id: 7 }
    payload.comment.body = '/close'

    expect((await deliver('issue_comment', payload, 'd-twice')).status).toBe(202)
    await eventually(async () => (await githubSaw()).some(s => s.method === 'PATCH'))
    expect((await deliver('issue_comment', payload, 'd-twice')).status).toBe(200)
    await new Promise(resolve => setTimeout(resolve, 300))

    expect((await githubSaw()).filter(s => s.method === 'PATCH')).toHaveLength(1)
    const deliveries = await mf.getKVNamespace('DELIVERIES', 'prow')
    expect(await deliveries.get('delivery:d-twice')).toBe('1')
  })
})
