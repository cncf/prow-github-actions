import type { WebhookPayload } from '@actions/github/lib/interfaces'
import { Context } from '@actions/github/lib/context'

export const api = 'https://api.github.com'

// Generate and create a fake context to use
export const MockContext = class extends Context {
  constructor(payload: WebhookPayload) {
    super()
    // clone so tests never mutate the shared imported fixture
    this.payload = structuredClone(payload)
  }
}

// Drop action inputs and the runner-provided GITHUB_* variables so that tests
// are hermetic when they run inside GitHub Actions (github.context reads
// GITHUB_REPOSITORY, GITHUB_EVENT_PATH, GITHUB_API_URL, ... from the env).
function clearActionEnv() {
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
