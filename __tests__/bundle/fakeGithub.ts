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
}

type Handler = (req: RecordedRequest) => FakeResponse

interface Route {
  method: string
  pattern: string | RegExp
  handler: Handler
}

export interface FakeGithub {
  url: string
  requests: RecordedRequest[]
  route: (method: string, pattern: string | RegExp, response: Handler | FakeResponse) => void
  /** answers with one response per call in order, repeating the last one */
  routeSequence: (method: string, pattern: string | RegExp, responses: FakeResponse[]) => void
  /** serves the combined commit status of `sha` under `repo` (`/repos/o/r`) and accepts status posts to it */
  commitStatuses: (repo: string, sha: string, statuses: { context: string, state: string }[]) => void
  requestsMatching: (method: string, pathRegex: RegExp) => RecordedRequest[]
  reset: () => void
  close: () => Promise<void>
}

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
  const requests: RecordedRequest[] = []

  const server = http.createServer(async (req, res) => {
    const recorded: RecordedRequest = {
      method: req.method ?? 'GET',
      path: req.url ?? '/',
      body: await readBody(req),
    }
    // unmatched requests are recorded too so tests can assert on unexpected traffic
    requests.push(recorded)

    const route = routes.find(r => matches(r, recorded))
    const response: FakeResponse = route
      ? route.handler(recorded)
      : { status: 404, body: { message: 'Not Found (fake)' } }

    res.statusCode = response.status
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
    requestsMatching(method, pathRegex) {
      return requests.filter(r => r.method === method.toUpperCase() && pathRegex.test(r.path))
    },
    reset() {
      routes.length = 0
      requests.length = 0
    },
    close() {
      return new Promise((resolve, reject) => {
        server.close(err => (err ? reject(err) : resolve()))
      })
    },
  }
}
