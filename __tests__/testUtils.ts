import type { Context } from '../src/utils/context'
import * as github from '@actions/github'
import { http } from 'msw'

import { resetProwConfigCache } from '../src/utils/config'

type WebhookPayload = Context['payload']

export const api = 'https://api.github.com'

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

// @actions/github exports only the context instance; extend its class via the prototype
const ContextClass = github.context.constructor as new () => Context

export class MockContext extends ContextClass {
  constructor(payload: WebhookPayload) {
    super()
    // clone so tests never mutate the shared imported fixture
    this.payload = structuredClone(payload)
  }
}

// Drop action inputs and the runner-provided GITHUB_* variables so that tests
// are hermetic when they run inside GitHub Actions (github.context reads
// GITHUB_REPOSITORY, GITHUB_EVENT_PATH, GITHUB_API_URL, ... from the env).
// The configuration cache lives for one action run, so it is reset here too.
function clearActionEnv() {
  resetProwConfigCache()
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
