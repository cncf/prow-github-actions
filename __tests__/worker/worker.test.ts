import { generateKeyPairSync } from 'node:crypto'
import path from 'node:path'
import { sign } from '@octokit/webhooks-methods'
import { Miniflare } from 'miniflare'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import issueCommentEvent from '../fixtures/issues/issueCommentEvent.json'
import pullReqOpenedEvent from '../fixtures/pullReq/pullReqOpenedEvent.json'

// Runs the bundle `wrangler deploy --dry-run --outdir dist-worker` produced (npm run pack:worker, or globalSetup.ts)
// inside workerd with KV, a Queue and the Durable Object, so this is the Worker as deployed.
// GitHub is a fake served by a second miniflare worker the first one's fetch is routed to.
const bundle = path.resolve('dist-worker/worker.js')
const secret = 'worker-secret'
const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } })

interface Seen { method: string, path: string, auth: string | null, body: string }

// the fake GitHub: every request is logged under its own LOG key (seen:<ms>-<uuid>, so two in flight at once —
// the org- and repo-tier config probes — cannot lose each other's write); LOG.prow.yaml, when set, is served as
// the repository's .github/prow.yaml, and LOG.installations = 'fail' makes GET /app/installations 500
const githubScript = `
export default {
  async fetch(request, env) {
    // octokit encodes the slash in a contents path (.github%2Fprow.yaml); log and match the decoded form
    const url = new URL(request.url)
    url.pathname = decodeURIComponent(url.pathname)
    const body = await request.text()
    await env.LOG.put('seen:' + String(Date.now()).padStart(15, '0') + '-' + crypto.randomUUID(), JSON.stringify({ method: request.method, path: url.pathname, auth: request.headers.get('authorization'), body }))
    if (url.pathname.endsWith('/access_tokens')) {
      return Response.json({ token: 'ghs_worker', expires_at: new Date(Date.now() + 3600000).toISOString(), permissions: {}, repository_selection: 'all' }, { status: 201 })
    }
    if (url.pathname.endsWith('/collaborators/Codertocat')) {
      return new Response(null, { status: 204 })
    }
    if (request.method === 'PATCH' && url.pathname.endsWith('/issues/1')) {
      return Response.json({})
    }
    if (url.pathname.endsWith('/app/installations')) {
      if ((await env.LOG.get('installations')) === 'fail') {
        return Response.json({ message: 'Server Error' }, { status: 500 })
      }
      return Response.json([{ id: 7, suspended_at: null }, { id: 8, suspended_at: '2026-01-01T00:00:00Z' }])
    }
    if (url.pathname.endsWith('/installation/repositories')) {
      return Response.json({ total_count: 3, repositories: [
        { id: 186853002, name: 'Hello-World', full_name: 'Codertocat/Hello-World', owner: { login: 'Codertocat' }, archived: false },
        { id: 186853003, name: 'Attic', full_name: 'Codertocat/Attic', owner: { login: 'Codertocat' }, archived: true },
        { id: 186853004, name: 'Spoon-Knife', full_name: 'Codertocat/Spoon-Knife', owner: { login: 'Codertocat' }, archived: false },
      ] })
    }
    if (url.pathname.endsWith('/repos/Codertocat/Hello-World/pulls') || url.pathname.endsWith('/repos/Codertocat/Spoon-Knife/pulls')) {
      return Response.json([])
    }
    if (url.pathname.endsWith('/contents/.github/prow.yaml')) {
      const text = await env.LOG.get('prow.yaml')
      if (text === null) {
        return Response.json({ message: 'Not Found' }, { status: 404 })
      }
      return Response.json({ type: 'file', encoding: 'base64', content: btoa(text) })
    }
    if (request.method === 'GET' && url.pathname.endsWith('/issues/1')) {
      return Response.json({ number: 1, state: 'open', labels: [] })
    }
    if (url.pathname.endsWith('/repos/Codertocat/Hello-World/labels')) {
      return Response.json([{ name: 'needs-kind' }])
    }
    if (request.method === 'POST' && url.pathname.endsWith('/issues/1/labels')) {
      return Response.json([{ name: 'needs-kind' }])
    }
    return Response.json({ message: 'Not Found' }, { status: 404 })
  },
}`

describe('the Worker', () => {
  let mf: Miniflare

  beforeAll(async () => {
    mf = new Miniflare({
      // lets a request to /cdn-cgi/handler/scheduled run the Worker's scheduled() handler
      unsafeTriggerHandlers: true,
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
          // one retry, so a message the consumer retry()s is seen delivered a second time
          queueConsumers: { 'prow-jobs': { maxBatchSize: 1, maxBatchTimeout: 0, maxRetries: 1 } },
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
    for (const key of [...(await log.list({ prefix: 'seen:' })).keys.map(key => key.name), 'prow.yaml', 'installations']) {
      await log.delete(key)
    }
    const deliveries = await mf.getKVNamespace('DELIVERIES', 'prow')
    for (const key of (await deliveries.list()).keys) {
      await deliveries.delete(key.name)
    }
  })
  afterAll(() => mf?.dispose())

  // in arrival order: KV lists keys sorted, and the key starts with the arrival time
  async function githubSaw(): Promise<Seen[]> {
    const log = await mf.getKVNamespace('LOG', 'github')
    const keys = (await log.list({ prefix: 'seen:' })).keys.map(key => key.name)
    return Promise.all(keys.map(async key => JSON.parse((await log.get(key))!) as Seen))
  }

  async function deliver(eventName: string, payload: unknown, id: string = crypto.randomUUID(), useSecret = secret) {
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

  it('scheduled(): one queue message per live installation, whose consumer runs the cron jobs for its unarchived repositories', async () => {
    const response = await mf.dispatchFetch('https://prow.test/cdn-cgi/handler/scheduled')
    expect(response.status).toBe(200)

    // the consumer's run ends in the lgtm job listing each repository's pull requests
    await eventually(async () => (await githubSaw()).some(s => s.path === '/api/v3/repos/Codertocat/Spoon-Knife/pulls'))
    await new Promise(resolve => setTimeout(resolve, 300))
    const seen = await githubSaw()

    // the producer: the App lists its installations with its jwt, mints a token for the live one, lists its repositories
    const listings = seen.filter(s => s.path === '/api/v3/app/installations')
    expect(listings[0]?.auth).toMatch(/^bearer ey/i)
    expect(seen.filter(s => s.path.endsWith('/access_tokens')).map(s => s.path)).toEqual(
      expect.arrayContaining(['/api/v3/app/installations/7/access_tokens']),
    )
    // the suspended installation is skipped by the producer and never reaches the consumer
    expect(seen.some(s => s.path === '/api/v3/app/installations/8/access_tokens')).toBe(false)

    // the consumer: exactly one more listing (one message for installation 7's two live repositories, not one per
    // repository) and the cron jobs for each unarchived repository under the installation token
    expect(listings).toHaveLength(2)
    expect(seen.filter(s => s.path === '/api/v3/installation/repositories')).toHaveLength(2)
    const pulls = seen.filter(s => s.path.endsWith('/pulls'))
    expect(pulls.map(s => s.path).sort()).toEqual(['/api/v3/repos/Codertocat/Hello-World/pulls', '/api/v3/repos/Codertocat/Spoon-Knife/pulls'])
    expect(pulls.every(s => s.auth === 'token ghs_worker')).toBe(true)
  })

  it('a schedule message whose run throws is retried, not acknowledged', async () => {
    const log = await mf.getKVNamespace('LOG', 'github')
    await log.put('installations', 'fail')

    const queue = await mf.getQueueProducer<{ kind: 'schedule', installationId: number }>('PROW_QUEUE', 'prow')
    await queue.send({ kind: 'schedule', installationId: 7 })

    // maxRetries is 1: the retried message lists installations a second time, an acknowledged one would not
    await eventually(async () => (await githubSaw()).filter(s => s.path === '/api/v3/app/installations').length >= 2)
    await new Promise(resolve => setTimeout(resolve, 300))
    expect((await githubSaw()).filter(s => s.path === '/api/v3/app/installations')).toHaveLength(2)
    expect((await githubSaw()).some(s => s.path.endsWith('/access_tokens'))).toBe(false)
  })

  it('a grace period defers require-matching-label through the queue, and the delayed message resumes it to the label', async () => {
    const log = await mf.getKVNamespace('LOG', 'github')
    await log.put('prow.yaml', 'require_matching_label:\n  - regexp: ^kind/\n    missing_label: needs-kind\n    prs: true\n    grace_period_duration: 1s\n')

    const payload = structuredClone(pullReqOpenedEvent) as typeof pullReqOpenedEvent & { installation?: { id: number } }
    payload.installation = { id: 7 }
    const response = await deliver('pull_request', payload, 'd-grace')
    expect(response.status).toBe(202)

    await eventually(async () => (await githubSaw()).some(s => s.method === 'POST' && s.path.endsWith('/issues/1/labels')))
    const seen = await githubSaw()

    // the webhook run read the configuration and stopped at defer(): the labels were not read before the queue hop
    const reads = seen.filter(s => s.method === 'GET' && s.path === '/api/v3/repos/Codertocat/Hello-World/issues/1')
    const configReads = seen.filter(s => s.path.endsWith('/contents/.github/prow.yaml'))
    expect(configReads.length).toBeGreaterThanOrEqual(2)
    expect(seen.indexOf(reads[0]!)).toBeGreaterThan(seen.indexOf(configReads[1]!))

    // the resumed run minted its own installation token (after the webhook run's config reads) and applied the missing label
    const mints = seen.filter(s => s.path.endsWith('/app/installations/7/access_tokens'))
    expect(seen.indexOf(mints.at(-1)!)).toBeGreaterThan(seen.indexOf(configReads[0]!))
    expect(seen.indexOf(mints.at(-1)!)).toBeLessThan(seen.indexOf(configReads[1]!))
    const labeled = seen.find(s => s.method === 'POST' && s.path.endsWith('/issues/1/labels'))
    expect(labeled?.auth).toBe('token ghs_worker')
    expect(JSON.parse(labeled!.body)).toEqual({ labels: ['needs-kind'] })
  })
})
