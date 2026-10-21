import type { AddressInfo } from 'node:net'
import { Buffer } from 'node:buffer'
import http from 'node:http'

export interface RecordedRequest {
  method: string
  path: string
  body: unknown
}

export interface FakeResponse {
  status: number
  body?: unknown
  headers?: Record<string, string>
}

type Handler = (req: RecordedRequest) => FakeResponse

interface Route {
  method: string
  pattern: string | RegExp
  handler: Handler
}

export interface MergeQueueFixture {
  pullRequestId: string
  headOid: string
  enabled: boolean
  inQueue?: boolean
  entry?: { state: string, position: number, enqueuer: string }
  /** GraphQL error message for the enqueue mutation */
  enqueueError?: string
  /** GraphQL error message for the state query */
  queryError?: string
  /** GraphQL error message for the dequeue mutation */
  dequeueError?: string
}

export interface FakeGithub {
  url: string
  requests: RecordedRequest[]
  /** the requests no route or fallback answered: the fake replied 404 to each of them */
  unmatched: RecordedRequest[]
  /**
   * declares that the scenario relies on the 404 the fake gives `method` requests to `pattern`
   * (a membership check meaning "not a member", an OWNERS read meaning "no such file"), so
   * `unexpectedRequests` and `assertNoUnexpectedRequests` leave them out
   */
  allowUnmatched: (method: string, pattern: string | RegExp) => void
  /** the unmatched requests no allowance covers; the configuration loader's probes are always allowed */
  unexpectedRequests: () => RecordedRequest[]
  /**
   * throws naming every unexpected request, so a scenario fails on traffic the application
   * answered itself (a swallowed GraphQL error, a tolerated read failure) instead of passing on it.
   * Call it from `afterEach`, with `reset` in a `finally`, so a failing scenario does not leak its
   * routes into the next one.
   */
  assertNoUnexpectedRequests: () => void
  route: (method: string, pattern: string | RegExp, response: Handler | FakeResponse) => void
  /** answers with one response per call in order, repeating the last one */
  routeSequence: (method: string, pattern: string | RegExp, responses: FakeResponse[]) => void
  /** serves the combined commit status of `sha` under `repo` (`/repos/o/r`) and accepts status posts to it */
  commitStatuses: (repo: string, sha: string, statuses: { context: string, state: string }[]) => void
  /** serves `POST /graphql`: the merge queue state query for one pull request, and the enqueue/dequeue mutations */
  mergeQueue: (queue: MergeQueueFixture) => void
  /** like mergeQueue, but consulted after every other route, so a test's own mergeQueue route wins */
  mergeQueueFallback: (queue: MergeQueueFixture) => void
  /** the recorded `POST /graphql` calls whose query names the operation, ex: `enqueuePullRequest` */
  graphqlCalls: (operation: string) => RecordedRequest[]
  requestsMatching: (method: string, pathRegex: RegExp) => RecordedRequest[]
  reset: () => void
  close: () => Promise<void>
}

/**
 * the configuration loader's reads, `GET /repos/<owner>/<repo>/contents/<prow.yaml | prow.yml |
 * .prowlabels.yaml | ... | .github%2Fprowlabels.yml>`: every run that routes no prow configuration
 * makes them and takes the defaults from their 404s, so they are never unexpected
 */
const configurationProbe = /^\/repos\/[^/]+\/[^/]+\/contents\/(?:\.github%2F)?\.?prow(?:labels)?\.ya?ml$/

function matches(route: Route, req: RecordedRequest): boolean {
  if (route.method !== req.method)
    return false
  if (typeof route.pattern === 'string')
    return req.path === route.pattern || req.path.split('?')[0] === route.pattern
  return route.pattern.test(req.path)
}

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString()
      if (raw === '')
        return resolve(undefined)
      try {
        resolve(JSON.parse(raw))
      }
      catch {
        resolve(raw)
      }
    })
  })
}

export async function start(): Promise<FakeGithub> {
  const routes: Route[] = []
  const fallbacks: Route[] = []
  const requests: RecordedRequest[] = []
  const unmatched: RecordedRequest[] = []
  const allowances: Route[] = [{ method: 'GET', pattern: configurationProbe, handler: () => ({ status: 404 }) }]

  const server = http.createServer(async (req, res) => {
    const recorded: RecordedRequest = {
      method: req.method ?? 'GET',
      path: req.url ?? '/',
      body: await readBody(req),
    }
    // unmatched requests are recorded too so tests can assert on unexpected traffic
    requests.push(recorded)

    const route = routes.find(r => matches(r, recorded)) ?? fallbacks.find(r => matches(r, recorded))
    if (route === undefined)
      unmatched.push(recorded)
    const response: FakeResponse = route
      ? route.handler(recorded)
      : { status: 404, body: { message: 'Not Found (fake)' } }

    res.statusCode = response.status
    for (const [name, value] of Object.entries(response.headers ?? {}))
      res.setHeader(name, value)
    if (response.body === undefined) {
      res.end()
    }
    else {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify(response.body))
    }
  })

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo

  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    unmatched,
    allowUnmatched(method, pattern) {
      allowances.push({ method: method.toUpperCase(), pattern, handler: () => ({ status: 404 }) })
    },
    unexpectedRequests() {
      return unmatched.filter(r => !allowances.some(a => matches(a, r)))
    },
    assertNoUnexpectedRequests() {
      const unexpected = this.unexpectedRequests()
      if (unexpected.length > 0) {
        const listing = unexpected.map(r => `  ${r.method} ${r.path}`).join('\n')
        throw new Error(`the fake GitHub API answered ${unexpected.length} request(s) no route or allowance covers:\n${listing}`)
      }
    },
    route(method, pattern, response) {
      const handler = typeof response === 'function' ? response : () => response
      routes.push({ method: method.toUpperCase(), pattern, handler })
    },
    routeSequence(method, pattern, responses) {
      let calls = 0
      routes.push({ method: method.toUpperCase(), pattern, handler: () => responses[Math.min(calls++, responses.length - 1)] })
    },
    commitStatuses(repo, sha, statuses) {
      routes.push({ method: 'GET', pattern: `${repo}/commits/${sha}/status`, handler: () => ({ status: 200, body: { state: statuses.some(s => s.state !== 'success') ? 'pending' : 'success', statuses } }) })
      routes.push({ method: 'POST', pattern: `${repo}/statuses/${sha}`, handler: () => ({ status: 201, body: {} }) })
    },
    mergeQueue(queue) {
      routes.push(mergeQueueRoute(queue))
    },
    mergeQueueFallback(queue) {
      fallbacks.push(mergeQueueRoute(queue))
    },
    graphqlCalls(operation) {
      return requests.filter(r => r.method === 'POST' && r.path === '/graphql' && String((r.body as { query?: string } | undefined)?.query ?? '').includes(operation))
    },
    requestsMatching(method, pathRegex) {
      return requests.filter(r => r.method === method.toUpperCase() && pathRegex.test(r.path))
    },
    reset() {
      routes.length = 0
      fallbacks.length = 0
      requests.length = 0
      unmatched.length = 0
      allowances.length = 1
    },
    close() {
      return new Promise((resolve, reject) => {
        server.close(err => (err ? reject(err) : resolve()))
      })
    },
  }
}

function mergeQueueRoute(queue: MergeQueueFixture): Route {
  return { method: 'POST', pattern: '/graphql', handler: (req) => {
    const query = String((req.body as { query?: string } | undefined)?.query ?? '')
    if (query.includes('enqueuePullRequest')) {
      return queue.enqueueError === undefined
        ? { status: 200, body: { data: { enqueuePullRequest: { mergeQueueEntry: { state: 'QUEUED', position: 1 } } } } }
        : { status: 200, body: { data: null, errors: [{ message: queue.enqueueError }] } }
    }
    if (query.includes('dequeuePullRequest')) {
      return queue.dequeueError === undefined
        ? { status: 200, body: { data: { dequeuePullRequest: { mergeQueueEntry: { state: 'QUEUED', position: 1 } } } } }
        : { status: 200, body: { data: null, errors: [{ message: queue.dequeueError }] } }
    }
    if (queue.queryError !== undefined)
      return { status: 200, body: { data: null, errors: [{ message: queue.queryError }] } }
    const entry = queue.entry
    return { status: 200, body: { data: { repository: { pullRequest: {
      id: queue.pullRequestId,
      headRefOid: queue.headOid,
      isMergeQueueEnabled: queue.enabled,
      isInMergeQueue: queue.inQueue ?? false,
      mergeQueueEntry: entry === undefined ? null : { state: entry.state, position: entry.position, enqueuer: { login: entry.enqueuer } },
    } } } } }
  } }
}
