import { generateKeyPairSync } from 'node:crypto'
import path from 'node:path'
import { sign } from '@octokit/webhooks-methods'
import { Miniflare } from 'miniflare'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import issueCommentEvent from '../fixtures/issues/issueCommentEvent.json'
import checkSuiteCompletedEvent from '../fixtures/pullReq/checkSuiteCompletedEvent.json'
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
// the repository's .github/prow.yaml. LOG.fail names, comma-separated, the calls that answer 500: tokens,
// repositories, pulls, labels, patch. LOG.slow = 'patch' holds a PATCH for a second and logs PATCH-DONE as it answers.
const githubScript = `
const log = (env, entry) => env.LOG.put('seen:' + String(Date.now()).padStart(15, '0') + '-' + crypto.randomUUID(), JSON.stringify(entry))
export default {
  async fetch(request, env) {
    // octokit encodes the slash in a contents path (.github%2Fprow.yaml); log and match the decoded form
    const url = new URL(request.url)
    url.pathname = decodeURIComponent(url.pathname)
    const body = await request.text()
    await log(env, { method: request.method, path: url.pathname, auth: request.headers.get('authorization'), body })
    const failing = ((await env.LOG.get('fail')) ?? '').split(',')
    const fail = () => Response.json({ message: 'Server Error' }, { status: 500 })
    if (url.pathname.endsWith('/access_tokens')) {
      if (failing.includes('tokens')) {
        return fail()
      }
      return Response.json({ token: 'ghs_worker', expires_at: new Date(Date.now() + 3600000).toISOString(), permissions: {}, repository_selection: 'all' }, { status: 201 })
    }
    if (url.pathname.endsWith('/collaborators/Codertocat')) {
      return new Response(null, { status: 204 })
    }
    if (request.method === 'PATCH' && /\\/issues\\/[12]$/.test(url.pathname)) {
      if (failing.includes('patch')) {
        return fail()
      }
      if ((await env.LOG.get('slow')) === 'patch') {
        await new Promise(resolve => setTimeout(resolve, 1000))
        await log(env, { method: 'PATCH-DONE', path: url.pathname, auth: null, body: '' })
      }
      return Response.json({})
    }
    if (url.pathname.endsWith('/app/installations')) {
      return Response.json([{ id: 7, suspended_at: null }, { id: 8, suspended_at: '2026-01-01T00:00:00Z' }])
    }
    if (url.pathname.endsWith('/installation/repositories')) {
      if (failing.includes('repositories')) {
        return fail()
      }
      return Response.json({ total_count: 3, repositories: [
        { id: 186853002, name: 'Hello-World', full_name: 'Codertocat/Hello-World', owner: { login: 'Codertocat' }, archived: false },
        { id: 186853003, name: 'Attic', full_name: 'Codertocat/Attic', owner: { login: 'Codertocat' }, archived: true },
        { id: 186853004, name: 'Spoon-Knife', full_name: 'Codertocat/Spoon-Knife', owner: { login: 'Codertocat' }, archived: false },
      ] })
    }
    if (url.pathname.endsWith('/repos/Codertocat/Hello-World/pulls') || url.pathname.endsWith('/repos/Codertocat/Spoon-Knife/pulls')) {
      if (failing.includes('pulls')) {
        return fail()
      }
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
      if (failing.includes('labels')) {
        return fail()
      }
      return Response.json([{ name: 'needs-kind' }])
    }
    return Response.json({ message: 'Not Found' }, { status: 404 })
  },
}`

function startWorker(): Miniflare {
  return new Miniflare({
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
}

// the queue messages the tests send; src/server/worker.ts is not imported here, since it only typechecks under
// tsconfig.worker.json's Workers types
type QueueMessage
  = | { kind: 'schedule', installationId: number }
    | { kind: 'deferred', delivery: { id: string, eventName: string, payload: unknown }, deferred: { kind: string } }

type Payload<T> = T & { installation?: { id: number } }

function withInstallation<T>(payload: T, id = 7): Payload<T> {
  const copy = structuredClone(payload) as Payload<T>
  copy.installation = { id }
  return copy
}

function closeComment(id = 7, issue = 1): Payload<typeof issueCommentEvent> {
  const payload = withInstallation(issueCommentEvent, id)
  payload.comment.body = '/close'
  payload.issue.number = issue
  return payload
}

async function githubSawIn(mf: Miniflare): Promise<Seen[]> {
  const log = await mf.getKVNamespace('LOG', 'github')
  const keys = (await log.list({ prefix: 'seen:' })).keys.map(key => key.name)
  return Promise.all(keys.map(async key => JSON.parse((await log.get(key))!) as Seen))
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

const requireKind = 'require_matching_label:\n  - regexp: ^kind/\n    missing_label: needs-kind\n    prs: true\n    grace_period_duration: 1s\n'

const settle = () => new Promise(resolve => setTimeout(resolve, 300))

describe('the Worker in a fresh isolate', () => {
  let mf: Miniflare
  beforeAll(async () => {
    mf = startWorker()
    await mf.ready
  }, 60_000)
  afterAll(() => mf?.dispose())

  it('runs a call to the Durable Object that no fetch() preceded under the module\'s own platform scope', async () => {
    const namespace = await mf.getDurableObjectNamespace('PULL_REQUEST_LOCK', 'prow')
    const lock = namespace.get(namespace.idFromName('Codertocat/Hello-World#1')) as unknown as { handle: (delivery: unknown) => Promise<void> }

    await lock.handle({ id: 'd-direct', eventName: 'issue_comment', payload: closeComment() })

    const patch = (await githubSawIn(mf)).find(s => s.method === 'PATCH')
    expect(patch?.path).toBe('/api/v3/repos/Codertocat/Hello-World/issues/1')
  })

  it('mints an installation token once per isolate, not once per delivery', async () => {
    const namespace = await mf.getDurableObjectNamespace('PULL_REQUEST_LOCK', 'prow')
    const lock = namespace.get(namespace.idFromName('Codertocat/Hello-World#1')) as unknown as { handle: (delivery: unknown) => Promise<void> }
    // the tests run in any order (npm run test:shuffle) and this isolate's log is never cleared: count this test's
    // own PATCHes, and every mint the isolate has made
    const patches = async () => (await githubSawIn(mf)).filter(s => s.method === 'PATCH').length
    const before = await patches()

    await lock.handle({ id: 'd-again', eventName: 'issue_comment', payload: closeComment() })
    await lock.handle({ id: 'd-and-again', eventName: 'issue_comment', payload: closeComment() })

    expect(await patches() - before).toBe(2)
    expect((await githubSawIn(mf)).filter(s => s.path.endsWith('/access_tokens'))).toHaveLength(1)
  })
})

describe('the Worker', () => {
  let mf: Miniflare

  beforeAll(async () => {
    mf = startWorker()
    await mf.ready
  }, 60_000)

  afterEach(async () => {
    const log = await mf.getKVNamespace('LOG', 'github')
    for (const key of [...(await log.list({ prefix: 'seen:' })).keys.map(key => key.name), 'prow.yaml', 'fail', 'slow']) {
      await log.delete(key)
    }
    const deliveries = await mf.getKVNamespace('DELIVERIES', 'prow')
    for (const key of (await deliveries.list()).keys) {
      await deliveries.delete(key.name)
    }
  })
  afterAll(() => mf?.dispose())

  // in arrival order: KV lists keys sorted, and the key starts with the arrival time
  const githubSaw = () => githubSawIn(mf)

  async function failing(...calls: string[]): Promise<void> {
    await (await mf.getKVNamespace('LOG', 'github')).put('fail', calls.join(','))
  }

  async function deliver(eventName: string, payload: unknown, id: string = crypto.randomUUID(), useSecret = secret) {
    const body = JSON.stringify(payload)
    return mf.dispatchFetch('https://prow.test/webhook', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-github-delivery': id, 'x-github-event': eventName, 'x-hub-signature-256': await sign(useSecret, body) },
      body,
    })
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
    // the isolate keeps the tokens it mints, and the tests run in any order (npm run test:shuffle): an installation
    // no other test delivers for has no token yet, so the mint this test looks for is its own
    const response = await deliver('issue_comment', closeComment(9), 'd-close')
    expect(response.status).toBe(202)

    await eventually(async () => (await githubSaw()).some(s => s.method === 'PATCH'))
    const seen = await githubSaw()
    // minted once, by the Durable Object that reads it; the receiver that hands the delivery over mints none
    const tokens = seen.filter(s => s.path.endsWith('/access_tokens'))
    expect(tokens.map(s => s.path)).toEqual(['/api/v3/app/installations/9/access_tokens'])
    expect(tokens[0]?.auth).toMatch(/^bearer ey/i)
    const patch = seen.find(s => s.method === 'PATCH')
    expect(patch?.path).toBe('/api/v3/repos/Codertocat/Hello-World/issues/1')
    expect(patch?.auth).toBe('token ghs_worker')
    expect(JSON.parse(patch!.body)).toEqual({ state: 'closed' })
  })

  it('handles a redelivered id once, remembering it in KV', async () => {
    const payload = closeComment()

    expect((await deliver('issue_comment', payload, 'd-twice')).status).toBe(202)
    await eventually(async () => (await githubSaw()).some(s => s.method === 'PATCH'))
    expect((await deliver('issue_comment', payload, 'd-twice')).status).toBe(200)
    await settle()

    expect((await githubSaw()).filter(s => s.method === 'PATCH')).toHaveLength(1)
    const deliveries = await mf.getKVNamespace('DELIVERIES', 'prow')
    expect(await deliveries.get('delivery:d-twice')).toBe('1')
  })

  it('forgets a pull request delivery whose run fails, so GitHub\'s redelivery runs it again', async () => {
    await failing('patch')
    const payload = closeComment()

    expect((await deliver('issue_comment', payload, 'd-close-fails')).status).toBe(202)
    await eventually(async () => (await githubSaw()).some(s => s.method === 'PATCH'))
    await settle()

    const deliveries = await mf.getKVNamespace('DELIVERIES', 'prow')
    expect(await deliveries.get('delivery:d-close-fails')).toBeNull()

    await failing()
    expect((await deliver('issue_comment', payload, 'd-close-fails')).status).toBe(202)
    await eventually(async () => (await githubSaw()).filter(s => s.method === 'PATCH').length === 2)
    await settle()
    expect(await deliveries.get('delivery:d-close-fails')).toBe('1')
    expect((await deliver('issue_comment', payload, 'd-close-fails')).status).toBe(200)
  })

  it('scheduled(): one queue message per live installation, whose consumer runs the cron jobs for its unarchived repositories', async () => {
    const response = await mf.dispatchFetch('https://prow.test/cdn-cgi/handler/scheduled')
    expect(response.status).toBe(200)

    // the consumer's run ends in the lgtm job listing each repository's pull requests
    await eventually(async () => (await githubSaw()).some(s => s.path === '/api/v3/repos/Codertocat/Spoon-Knife/pulls'))
    await settle()
    const seen = await githubSaw()

    // the producer lists the installations with the App's jwt, and nothing else: no token, no repository
    const listings = seen.filter(s => s.path === '/api/v3/app/installations')
    expect(listings).toHaveLength(1)
    expect(listings[0]?.auth).toMatch(/^bearer ey/i)
    // the suspended installation is skipped by the producer and never reaches the consumer
    expect(seen.some(s => s.path === '/api/v3/app/installations/8/access_tokens')).toBe(false)

    // the consumer lists the repositories of its own installation once, under that installation's token, and runs
    // the cron jobs for each unarchived one
    const repositories = seen.filter(s => s.path === '/api/v3/installation/repositories')
    expect(repositories.map(s => s.auth)).toEqual(['token ghs_worker'])
    const pulls = seen.filter(s => s.path.endsWith('/pulls'))
    expect(pulls.map(s => s.path).sort()).toEqual(['/api/v3/repos/Codertocat/Hello-World/pulls', '/api/v3/repos/Codertocat/Spoon-Knife/pulls'])
    expect(pulls.every(s => s.auth === 'token ghs_worker')).toBe(true)
  })

  it('a schedule message whose run throws is retried, not acknowledged', async () => {
    await failing('repositories')

    const queue = await mf.getQueueProducer<QueueMessage>('PROW_QUEUE', 'prow')
    await queue.send({ kind: 'schedule', installationId: 7 })

    // maxRetries is 1: the retried message lists the repositories a second time, an acknowledged one would not
    const listed = async () => (await githubSaw()).filter(s => s.path === '/api/v3/installation/repositories')
    await eventually(async () => (await listed()).length >= 2)
    await settle()
    expect(await listed()).toHaveLength(2)
    expect((await githubSaw()).some(s => s.path === '/api/v3/app/installations')).toBe(false)
  })

  it('a grace period defers require-matching-label through the queue, and the delayed message resumes it to the label', async () => {
    const log = await mf.getKVNamespace('LOG', 'github')
    await log.put('prow.yaml', requireKind)

    const payload = withInstallation(pullReqOpenedEvent)
    const response = await deliver('pull_request', payload, 'd-grace')
    expect(response.status).toBe(202)

    await eventually(async () => (await githubSaw()).some(s => s.method === 'POST' && s.path.endsWith('/issues/1/labels')))
    const seen = await githubSaw()

    // the webhook run read the configuration and stopped at defer(): the labels were not read before the queue hop
    const reads = seen.filter(s => s.method === 'GET' && s.path === '/api/v3/repos/Codertocat/Hello-World/issues/1')
    const configReads = seen.filter(s => s.path.endsWith('/contents/.github/prow.yaml'))
    expect(configReads.length).toBeGreaterThanOrEqual(2)
    expect(seen.indexOf(reads[0]!)).toBeGreaterThan(seen.indexOf(configReads[1]!))

    // the resumed run applied the missing label under the installation token
    const labeled = seen.find(s => s.method === 'POST' && s.path.endsWith('/issues/1/labels'))
    expect(labeled?.auth).toBe('token ghs_worker')
    expect(JSON.parse(labeled!.body)).toEqual({ labels: ['needs-kind'] })
  })

  it('a deferred check carries the delivery once, so a payload over half the queue\'s 128 KB limit still defers', async () => {
    const log = await mf.getKVNamespace('LOG', 'github')
    await log.put('prow.yaml', requireKind)

    const payload = withInstallation(pullReqOpenedEvent)
    payload.pull_request.body = 'x'.repeat(70_000)
    expect((await deliver('pull_request', payload, 'd-big')).status).toBe(202)

    await eventually(async () => (await githubSaw()).some(s => s.method === 'POST' && s.path.endsWith('/issues/1/labels')))
  })

  it('a deferred check whose resumed run fails is retried, not acknowledged', async () => {
    const log = await mf.getKVNamespace('LOG', 'github')
    await log.put('prow.yaml', requireKind)
    await failing('labels')

    const queue = await mf.getQueueProducer<QueueMessage>('PROW_QUEUE', 'prow')
    await queue.send({ kind: 'deferred', delivery: { id: 'd-resume-fails', eventName: 'pull_request', payload: withInstallation(pullReqOpenedEvent) }, deferred: { kind: 'require-matching-label' } })

    // maxRetries is 1: the retried message labels a second time, an acknowledged one would not
    const labelings = async () => (await githubSaw()).filter(s => s.method === 'POST' && s.path.endsWith('/issues/1/labels'))
    await eventually(async () => (await labelings()).length >= 2)
    await settle()
    expect(await labelings()).toHaveLength(2)
  })

  it('runs one pull request\'s overlapping deliveries one after the other, and another pull request\'s alongside them', async () => {
    await (await mf.getKVNamespace('LOG', 'github')).put('slow', 'patch')

    await deliver('issue_comment', closeComment(7, 1), 'd-first')
    await deliver('issue_comment', closeComment(7, 1), 'd-second')
    await deliver('issue_comment', closeComment(7, 2), 'd-other')
    await eventually(async () => (await githubSaw()).filter(s => s.method === 'PATCH-DONE').length >= 3)

    const seen = await githubSaw()
    const at = (method: string, issue: number) => seen.flatMap((s, i) => s.method === method && s.path.endsWith(`/issues/${issue}`) ? [i] : [])
    const [firstPatch, secondPatch] = at('PATCH', 1)
    const [firstDone] = at('PATCH-DONE', 1)
    expect(secondPatch).toBeGreaterThan(firstDone!)
    expect(at('PATCH', 2)[0]).toBeLessThan(firstDone!)
    expect(firstPatch).toBeLessThan(firstDone!)
  })

  it('resumes a deferred check inside its pull request\'s lock, after the event that holds it', async () => {
    const log = await mf.getKVNamespace('LOG', 'github')
    await log.put('prow.yaml', requireKind)
    await log.put('slow', 'patch')

    await deliver('issue_comment', closeComment(7, 1), 'd-holds-the-lock')
    await eventually(async () => (await githubSaw()).some(s => s.method === 'PATCH'))
    const queue = await mf.getQueueProducer<QueueMessage>('PROW_QUEUE', 'prow')
    await queue.send({ kind: 'deferred', delivery: { id: 'd-waits', eventName: 'pull_request', payload: withInstallation(pullReqOpenedEvent) }, deferred: { kind: 'require-matching-label' } })
    await eventually(async () => (await githubSaw()).some(s => s.method === 'POST' && s.path.endsWith('/issues/1/labels')))

    // nothing reached GitHub while the /close held the lock: the resumed check waited for it
    const methods = (await githubSaw()).map(s => s.method)
    expect(methods.indexOf('PATCH-DONE')).toBe(methods.indexOf('PATCH') + 1)
  })

  it('runs a delivery about no issue or pull request from the queue, under the installation token', async () => {
    expect((await deliver('check_suite', withInstallation(checkSuiteCompletedEvent), 'd-suite')).status).toBe(202)

    await eventually(async () => (await githubSaw()).some(s => s.path === '/api/v3/repos/Codertocat/Hello-World/pulls'))
    const pulls = (await githubSaw()).filter(s => s.path === '/api/v3/repos/Codertocat/Hello-World/pulls')
    expect(pulls.map(s => s.auth)).toEqual(['token ghs_worker'])
  })

  it('a delivery about no issue or pull request whose run fails is retried, not acknowledged', async () => {
    await failing('pulls')

    expect((await deliver('check_suite', withInstallation(checkSuiteCompletedEvent), 'd-suite-fails')).status).toBe(202)

    // maxRetries is 1: the retried message looks the pull requests up a second time, waitUntil would not
    const lookups = async () => (await githubSaw()).filter(s => s.path === '/api/v3/repos/Codertocat/Hello-World/pulls')
    await eventually(async () => (await lookups()).length >= 2)
    await settle()
    expect(await lookups()).toHaveLength(2)
  })
})
