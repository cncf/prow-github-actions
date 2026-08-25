import type { Context } from '@actions/github/lib/context'
import * as core from '@actions/core'
import * as github from '@actions/github'

import { Octokit } from '@octokit/rest'

import { createComment } from '../utils/comments'

const catApi = 'https://api.thecatapi.com/v1/images/search?limit=1&size=med'

// a line of exactly /meow, not /meowvie or a mention
const meowCommand = /^[\t ]*\/meow[\t ]*$/m

// bounded so a slow provider cannot stall the runner; exported so tests can shrink the waits
export const meowConfig = {
  timeoutMs: 5_000,
  maxAttempts: 3,
  retryDelayMs: 500,
}

/**
 * /meow replies with a random cat image
 *
 * @param context - the github actions event context
 */
export async function meow(context: Context = github.context): Promise<void> {
  if (!hasMeowCommand(context.payload.comment?.body))
    return

  const token = core.getInput('github-token', { required: true })
  const octokit = new Octokit({ auth: token })

  const issueNumber: number | undefined = context.payload.issue?.number
  if (issueNumber === undefined) {
    throw new Error(
      `github context payload missing issue number: ${context.payload}`,
    )
  }

  // a provider outage degrades to a note; only the github write can fail the action
  let body: string
  try {
    const image = await fetchCatImage()
    body = `![cat](<${image.href}>)`
  }
  catch (error) {
    core.warning(`Could not fetch a cat image: ${error}`)
    body = 'The cat API is unavailable right now.'
  }

  await createComment(octokit, context, issueNumber, body)
}

// hasMeowCommand reports whether the body has a standalone /meow line
function hasMeowCommand(body: unknown): boolean {
  return typeof body === 'string' && meowCommand.test(body)
}

async function fetchCatImage(): Promise<URL> {
  const headers: Record<string, string> = { accept: 'application/json' }
  const key = core.getInput('cat-api-key', { required: false })
  if (key !== '') {
    core.setSecret(key)
    headers['x-api-key'] = key
  }

  let lastError: unknown = new Error('cat api was not reached')
  for (let attempt = 1; attempt <= meowConfig.maxAttempts; attempt++) {
    if (attempt > 1)
      await delay(meowConfig.retryDelayMs)

    try {
      const response = await fetch(catApi, {
        headers,
        // refuse redirects so the api key cannot leak cross-origin
        redirect: 'manual',
        signal: AbortSignal.timeout(meowConfig.timeoutMs),
      })

      if (response.ok && response.type !== 'opaqueredirect')
        return parseCatImage(await response.json())

      // undici holds the socket until the body is read
      await cancelResponseBody(response)

      // retry a 5xx; a 429, a redirect, and other 4xx fall back
      const error = new Error(
        `cat api responded with ${response.status || 'a redirect'}`,
      )
      if (response.status >= 500) {
        lastError = error
        continue
      }
      throw error
    }
    catch (error) {
      // retry a network failure; a timeout has spent its deadline
      if (!(error instanceof TypeError))
        throw error
      lastError = error
    }
  }

  throw lastError
}

async function cancelResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel()
  }
  catch (error) {
    core.debug(`could not cancel cat api response body: ${error}`)
  }
}

// parseCatImage validates the response and returns a usable https url
function parseCatImage(value: unknown): URL {
  const images = value as Array<{ url?: unknown }>
  if (!Array.isArray(images) || images.length === 0)
    throw new Error('cat api returned no images')

  const url = images[0]?.url
  if (typeof url !== 'string')
    throw new Error('cat api returned an invalid image record')
  if (url.length > 4096)
    throw new Error('cat api returned an excessively long image url')

  let image: URL
  try {
    image = new URL(url)
  }
  catch {
    throw new Error('cat api returned an invalid image url')
  }

  if (
    image.protocol !== 'https:'
    || image.username !== ''
    || image.password !== ''
  ) {
    throw new Error('cat api returned an unusable image url')
  }

  return image
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}
