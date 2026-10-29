import type { SetupServerApi } from 'msw/node'
import type { Context } from '../src/utils/context'
import { http } from 'msw'

import { afterEach, beforeEach, expect } from 'vitest'
import { actionsPlatform } from '../src/adapters/actions'
import { setPlatform } from '../src/platform'

type WebhookPayload = Context['payload']

export const api = 'https://api.github.com'

/**
 * failOnUnhandledRequest makes `server.listen` reject any request no handler
 * answers instead of passing it through to the network. msw 2 reads
 * `onUnhandledRequest`, msw 3 reads `onUnhandledFrame`; naming both keeps the
 * suite offline on either version.
 */
export const failOnUnhandledRequest = { onUnhandledRequest: 'error', onUnhandledFrame: 'error' } as const

/**
 * failTestOnUnhandledRequests makes a request that `failOnUnhandledRequest`
 * rejected fail the test it happened in. The rejection alone does not: the
 * code under test receives it as a network error, and a fallback that catches
 * it (fail-open authorization, a warning, a skipped step) lets the test pass
 * while the request it meant to assert on was never served.
 *
 * Call it once at file level, right after `setupServer()`. The listener is
 * re-attached before every test, so an `afterEach` that calls
 * `server.events.removeAllListeners()` does not disarm it. A test that leaves a
 * request deliberately unserved opts out with `.allow()`; the allowance lasts
 * for that test only.
 *
 * @param server - the file's msw server
 */
export function failTestOnUnhandledRequests(server: SetupServerApi) {
  const unhandled: string[] = []
  let allowed = false
  const record = ({ request }: { request: Request }) => {
    unhandled.push(`${request.method} ${request.url}`)
  }
  const check = () => {
    if (!allowed && unhandled.length > 0) {
      expect.fail(`${unhandled.length} request(s) no handler served (a test that leaves one unserved on purpose calls .allow() on the object failTestOnUnhandledRequests returned):\n  ${unhandled.join('\n  ')}`)
    }
  }
  beforeEach(() => {
    unhandled.length = 0
    allowed = false
    server.events.on('request:unhandled', record)
  })
  afterEach(() => {
    server.events.removeListener('request:unhandled', record)
    check()
  })
  return {
    /** lets the current test leave requests unserved */
    allow() {
      allowed = true
    },
    /** the requests no handler served so far in the current test, as `METHOD url` */
    seen() {
      return [...unhandled]
    },
    /** what the afterEach runs: fails unless nothing is unserved or the test called allow() */
    check,
  }
}

/** every file the prow configuration loader probes for Codertocat/Hello-World, as `owner/repo:path` */
export const configProbes = [
  'Codertocat/.project:prow.yaml',
  'Codertocat/.github:prow.yaml',
  'Codertocat/Hello-World:.github/prow.yaml',
  'Codertocat/Hello-World:.github/prowlabels.yaml',
  'Codertocat/Hello-World:prow.yaml',
  'Codertocat/Hello-World:.prowlabels.yaml',
  'Codertocat/Hello-World:.github/prow.yml',
  'Codertocat/Hello-World:.github/prowlabels.yml',
  'Codertocat/Hello-World:prow.yml',
  'Codertocat/Hello-World:.prowlabels.yml',
]

// a bare path such as '.prowlabels.yaml' refers to Codertocat/Hello-World
function qualify(source: string): string {
  return source.includes(':') ? source : `Codertocat/Hello-World:${source}`
}

export function contentsUrl(source: string): string {
  const [repo, path] = qualify(source).split(':')
  return `${api}/repos/${repo}/contents/${encodeURIComponent(path)}`
}

/**
 * noOrgOrRepoConfigExcept answers 404 to every configuration probe except the
 * given ones, which the caller serves itself.
 *
 * @param except - `owner/repo:path` or repo-relative paths that exist
 */
export function noOrgOrRepoConfigExcept(...except: string[]) {
  const existing = except.map(qualify)
  return configProbes
    .filter(source => !existing.includes(source))
    .map(source => http.get(contentsUrl(source), mockResponse(404, { message: 'Not Found' })))
}

/**
 * repoHasLabels serves `GET /repos/Codertocat/Hello-World/labels` with the
 * given labels on a single page (any `per_page`/`page` query is ignored), so
 * that label commands may apply them.
 *
 * @param labels - names, or `{ name, color?, description? }` entries
 * @param observeReq - optionally records the request
 */
export function repoHasLabels(
  labels: (string | { name: string, color?: string, description?: string | null })[],
  observeReq?: ObserveRequest,
) {
  const body = labels.map(label => (typeof label === 'string' ? { name: label } : label))
  return http.get(`${api}/repos/Codertocat/Hello-World/labels`, mockResponse(200, body, observeReq))
}

/**
 * defaultBranchTree serves the recursive tree of Codertocat/Hello-World's
 * `master`, the default branch and the base of every fixture pull request,
 * which is how the tide gate and the approve plugin learn whether that branch
 * has OWNERS files.
 *
 * @param paths - the blob paths in the tree, ex: ['OWNERS', 'README.md']
 * @param observeReq - optionally records the request
 */
export function defaultBranchTree(paths: string[] = [], observeReq?: ObserveRequest) {
  const tree = paths.map(path => ({ path, mode: '100644', type: 'blob', sha: `blob-${path.replace(/\//g, '-')}` }))
  return http.get(`${api}/repos/Codertocat/Hello-World/git/trees/master`, mockResponse(200, { sha: 'master', truncated: false, tree }, observeReq))
}

/**
 * lgtmStatus serves the combined commit status of `sha` (any sha by default):
 * with `bound`, the head carries the `prow/lgtm` success status the merge
 * path requires next to the `lgtm` label.
 *
 * @param sha - the head commit, or an msw path parameter
 * @param bound - whether `prow/lgtm` is `success` on it
 * @param observeReq - optionally records the request
 */
export function lgtmStatus(sha = ':sha', bound = true, observeReq?: ObserveRequest) {
  const statuses = bound ? [{ context: 'prow/lgtm', state: 'success', description: 'lgtm by alice' }] : []
  return http.get(`${api}/repos/Codertocat/Hello-World/commits/${sha}/status`, mockResponse(200, { state: bound ? 'success' : 'pending', statuses }, observeReq))
}

export class MockContext implements Context {
  eventName = ''
  payload: WebhookPayload
  constructor(payload: WebhookPayload) {
    // clone so tests never mutate the shared imported fixture
    this.payload = structuredClone(payload)
  }

  get repo(): { owner: string, repo: string } {
    const repository = this.payload.repository
    if (repository) {
      return { owner: repository.owner.login, repo: repository.name }
    }
    // schedule and workflow_dispatch payloads carry no repository; the runner's env names it, as @actions/github does
    const [owner, repo] = (process.env.GITHUB_REPOSITORY ?? '').split('/')
    if (!owner || !repo) {
      throw new Error('context.repo requires a repository in the payload or GITHUB_REPOSITORY')
    }
    return { owner, repo }
  }
}

/** newRun installs a fresh Actions platform, and with it an empty RunState: what a new action run sees */
export function newRun(): void {
  setPlatform(actionsPlatform())
}

// Drop action inputs and the runner-provided GITHUB_* variables so that tests
// are hermetic when they run inside GitHub Actions (github.context reads
// GITHUB_REPOSITORY, GITHUB_EVENT_PATH, GITHUB_API_URL, ... from the env).
// The memoized state lives for one action run, so a new run starts here too.
function clearActionEnv() {
  newRun()
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('INPUT_') || key.startsWith('GITHUB_')) {
      delete process.env[key]
    }
  }
}

export function setupActionsEnv(command: string = '') {
  clearActionEnv()

  // set the neccessary env variables expected by the action:
  // https://help.github.com/en/github/automating-your-workflow-with-github-actions/workflow-syntax-for-github-actions#jobsjob_idstepswith
  process.env['INPUT_PROW-COMMANDS'] = command
  process.env['INPUT_GITHUB-TOKEN'] = 'some-token'
}

export function setupJobsEnv(arg: string = '') {
  clearActionEnv()

  // set the neccessary env variables expected by the action:
  // https://help.github.com/en/github/automating-your-workflow-with-github-actions/workflow-syntax-for-github-actions#jobsjob_idstepswith
  process.env.INPUT_JOBS = arg
  process.env['INPUT_GITHUB-TOKEN'] = 'some-token'
}

export class ObserveRequest {
  private _ref: Request | null = null

  public set ref(req: Request) {
    this._ref = req
  }

  public get ref(): Request | null {
    return this._ref
  }

  public async body() {
    if (!this._ref) {
      return null
    }

    // Clone the request before reading the body to avoid consuming the stream
    const clonedRequest = this._ref.clone()

    try {
      // Parse the body as JSON
      return await clonedRequest.json()
    }
    catch (error) {
      console.error('Error parsing request body:', error)
      return null
    }
  }

  // resolves once the observed request arrives; rejects after timeoutMs so a
  // missing request fails the test instead of hanging the worker
  public called(timeoutMs = 2000) {
    return new Promise<string>((resolve, reject) => {
      const deadline = Date.now() + timeoutMs
      const interval = setInterval(() => {
        if (this._ref) {
          clearInterval(interval)
          resolve('called')
        }
        else if (Date.now() >= deadline) {
          clearInterval(interval)
          reject(new Error(`observed request was not called within ${timeoutMs}ms`))
        }
      }, 1)
    })
  }

  // resolves after waitMs if the request never arrived; rejects if it did
  public notCalled(waitMs = 50) {
    return new Promise<string>((resolve, reject) => {
      setTimeout(() => {
        if (this._ref) {
          reject(new Error(`expected request not to be called: ${this._ref.method} ${this._ref.url}`))
        }
        else {
          resolve('not called')
        }
      }, waitMs)
    })
  }
}

export function mockResponse(
  replyCode: number,
  replyBody?: any,
  observeReq?: ObserveRequest,
) {
  return async ({ request }: { request: Request }) => {
    if (observeReq instanceof ObserveRequest) {
      observeReq.ref = request
    }

    if (replyBody) {
      return new Response(JSON.stringify(replyBody), {
        status: replyCode,
        headers: {
          'Content-Type': 'application/json',
        },
      })
    }
    else {
      return new Response(null, { status: replyCode })
    }
  }
}

export interface GraphqlCall {
  query: string
  variables: Record<string, unknown>
}

export interface MergeQueueFixture {
  /** the base branch requires a merge queue; default true */
  enabled?: boolean
  inQueue?: boolean
  /** the queue entry; `null` answers `isInMergeQueue: true` with `mergeQueueEntry: null`; `enqueuer: null` reports no enqueuer */
  entry?: { state: string, position: number, enqueuer?: string | null } | null
  /** the position the enqueue mutation reports; `null` answers `mergeQueueEntry: null`; default 3 */
  enqueuePosition?: number | null
  headOid?: string
  pullRequestId?: string
  /** GraphQL error message for the enqueue mutation */
  enqueueError?: string
  /** GraphQL error message for the state query */
  queryError?: string
  dequeueError?: string
}

/**
 * mergeQueueGraphql serves `POST /graphql`, dispatching on the operation
 * named in the query text: the merge queue state query, the enqueue and the
 * dequeue mutations. Every call is pushed to the returned array.
 *
 * @param queue - what the state query answers, and which operations fail
 * @param calls - collects the calls, newest last
 */
export function mergeQueueGraphql(queue: MergeQueueFixture = {}, calls: GraphqlCall[] = []) {
  const handler = http.post(`${api}/graphql`, async ({ request }) => {
    const body = await request.json() as GraphqlCall
    calls.push(body)
    const respond = (data: unknown, error?: string) =>
      new Response(JSON.stringify(error === undefined ? { data } : { data: null, errors: [{ message: error }] }), { status: 200, headers: { 'Content-Type': 'application/json' } })

    if (body.query.includes('enqueuePullRequest')) {
      return queue.enqueueError === undefined
        ? respond({ enqueuePullRequest: { mergeQueueEntry: queue.enqueuePosition === null ? null : { state: 'QUEUED', position: queue.enqueuePosition ?? 3 } } })
        : respond(null, queue.enqueueError)
    }
    if (body.query.includes('dequeuePullRequest')) {
      return queue.dequeueError === undefined
        ? respond({ dequeuePullRequest: { mergeQueueEntry: { state: 'QUEUED', position: 1 } } })
        : respond(null, queue.dequeueError)
    }
    if (queue.queryError !== undefined) {
      return respond(null, queue.queryError)
    }
    const inQueue = queue.inQueue ?? false
    const entry = queue.entry === undefined ? (inQueue ? { state: 'QUEUED', position: 2, enqueuer: 'github-actions' } : null) : queue.entry
    return respond({
      repository: {
        pullRequest: {
          id: queue.pullRequestId ?? 'PR_kwDOtest',
          headRefOid: queue.headOid ?? 'headsha',
          isMergeQueueEnabled: queue.enabled ?? true,
          isInMergeQueue: inQueue,
          mergeQueueEntry: entry === null ? null : { state: entry.state, position: entry.position, enqueuer: entry.enqueuer === null ? null : { login: entry.enqueuer ?? 'github-actions' } },
        },
      },
    })
  })
  return { handler, calls }
}

/**
 * noMergeQueue answers the merge queue state query for any pull request with
 * `isMergeQueueEnabled: false`, what GitHub reports for a base branch without a
 * merge queue, so tide merges directly. Without it an unserved `POST /graphql`
 * reaches the same direct merge through readQueueState's "could not read the
 * merge queue state" fallback, which failTestOnUnhandledRequests rejects.
 */
export const noMergeQueue = mergeQueueGraphql({ enabled: false }).handler

export function graphqlMutations(calls: GraphqlCall[], name: string) {
  return calls.filter(call => call.query.includes(name))
}
