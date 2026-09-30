import type { AddressInfo } from 'node:net'
import type { FakeGithub } from './fakeGithub'
import http from 'node:http'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import issueCommentEvent from '../fixtures/issues/issueCommentEvent.json'
import { start } from './fakeGithub'
import { runBundle } from './runBundle'

vi.setConfig({ testTimeout: 30_000 })

const repo = '/repos/Codertocat/Hello-World'
const token = { 'github-token': 'some-token' }
const preload = path.resolve(__dirname, 'catApiPreload.cjs')
const image = 'https://cdn2.thecatapi.com/images/MTY3ODIyMQ.jpg'
const fallback = 'The cat API is unavailable right now.'

interface CatRequest {
  path: string
  headers: http.IncomingHttpHeaders
}

interface CatResponse {
  status: number
  body?: unknown
  headers?: Record<string, string>
}

// a stand-in for api.thecatapi.com: answers one queued response per request, repeating the last
async function startCatApi() {
  const requests: CatRequest[] = []
  let queue: CatResponse[] = []
  const server = http.createServer((req, res) => {
    requests.push({ path: req.url ?? '', headers: req.headers })
    const next = queue.length > 1 ? queue.shift()! : queue[0] ?? { status: 500 }
    res.writeHead(next.status, { 'content-type': 'application/json', ...next.headers })
    res.end(next.body === undefined ? '' : JSON.stringify(next.body))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo
  return {
    url: `http://127.0.0.1:${port}`,
    requests,
    answer(...responses: CatResponse[]) {
      queue = responses
    },
    reset() {
      requests.length = 0
      queue = []
    },
    close: () => new Promise<void>((resolve, reject) => server.close(e => (e ? reject(e) : resolve()))),
  }
}

function comment(body: string) {
  const payload = structuredClone(issueCommentEvent)
  payload.comment.body = body
  return payload
}

describe('dist/index.js issue_comment /meow', () => {
  let gh: FakeGithub
  let cat: Awaited<ReturnType<typeof startCatApi>>

  beforeAll(async () => {
    gh = await start()
    cat = await startCatApi()
  })
  afterEach(() => {
    gh.reset()
    cat.reset()
  })
  afterAll(async () => {
    await gh.close()
    await cat.close()
  })

  function meow(body: string, inputs: Record<string, string> = {}) {
    return runBundle({
      eventName: 'issue_comment',
      payload: comment(body),
      inputs: { ...token, 'prow-commands': '/meow', ...inputs },
      apiUrl: gh.url,
      env: { NODE_OPTIONS: `--require "${preload}"`, CAT_API_URL: cat.url },
    })
  }

  function postedComments() {
    return gh.requestsMatching('POST', /\/issues\/1\/comments$/).map(r => (r.body as { body: string }).body)
  }

  function calls() {
    return gh.requests.map(r => `${r.method} ${r.path}`)
  }

  it('posts the image the cat api returns, with no authorization read and no sweep', async () => {
    cat.answer({ status: 200, body: [{ url: image }] })
    gh.route('POST', `${repo}/issues/1/comments`, { status: 201, body: {} })

    const result = await meow('/meow')

    expect(result.status, result.stdout).toBe(0)
    expect(result.errors).toEqual([])
    expect(result.stdout).not.toMatch(/::warning::/)
    expect(calls()).toEqual([`POST ${repo}/issues/1/comments`])
    expect(postedComments()).toEqual([`![cat](<${image}>)`])
    expect(cat.requests).toHaveLength(1)
    expect(cat.requests[0].path).toBe('/v1/images/search?limit=1&size=med')
    expect(cat.requests[0].headers.accept).toBe('application/json')
    expect(cat.requests[0].headers['x-api-key']).toBeUndefined()
  })

  it('sends the cat-api-key input as x-api-key and masks it in the log', async () => {
    cat.answer({ status: 200, body: [{ url: image }] })
    gh.route('POST', `${repo}/issues/1/comments`, { status: 201, body: {} })

    const result = await meow('/meow', { 'cat-api-key': 'live_secret' })

    expect(result.status, result.stdout).toBe(0)
    expect(cat.requests[0].headers['x-api-key']).toBe('live_secret')
    expect(result.stdout).toMatch(/^::add-mask::live_secret$/m)
    expect(postedComments()).toEqual([`![cat](<${image}>)`])
  })

  it('retries a 5xx from the cat api and posts the image once it answers', async () => {
    cat.answer({ status: 503, body: { message: 'overloaded' } }, { status: 200, body: [{ url: image }] })
    gh.route('POST', `${repo}/issues/1/comments`, { status: 201, body: {} })

    const result = await meow('/meow')

    expect(result.status, result.stdout).toBe(0)
    expect(result.stdout).not.toMatch(/::warning::/)
    expect(cat.requests).toHaveLength(2)
    expect(postedComments()).toEqual([`![cat](<${image}>)`])
  })

  it('gives up after three 5xx answers and posts the unavailable note; the run still succeeds', async () => {
    cat.answer({ status: 500 })
    gh.route('POST', `${repo}/issues/1/comments`, { status: 201, body: {} })

    const result = await meow('/meow')

    expect(result.status, result.stdout).toBe(0)
    expect(result.errors).toEqual([])
    expect(cat.requests).toHaveLength(3)
    expect(result.stdout).toMatch(/::warning::Could not fetch a cat image: Error: cat api responded with 500/)
    expect(postedComments()).toEqual([fallback])
  })

  it('does not retry a 4xx: one cat api call, then the unavailable note', async () => {
    cat.answer({ status: 429, body: { message: 'slow down' } })
    gh.route('POST', `${repo}/issues/1/comments`, { status: 201, body: {} })

    const result = await meow('/meow')

    expect(result.status, result.stdout).toBe(0)
    expect(cat.requests).toHaveLength(1)
    expect(result.stdout).toMatch(/::warning::Could not fetch a cat image: Error: cat api responded with 429/)
    expect(postedComments()).toEqual([fallback])
  })

  it('never follows a redirect from the cat api, so the key cannot travel cross-origin', async () => {
    cat.answer({ status: 302, headers: { location: `${cat.url}/elsewhere` } })
    gh.route('POST', `${repo}/issues/1/comments`, { status: 201, body: {} })

    const result = await meow('/meow', { 'cat-api-key': 'live_secret' })

    expect(result.status, result.stdout).toBe(0)
    expect(cat.requests.map(r => r.path)).toEqual(['/v1/images/search?limit=1&size=med'])
    expect(result.stdout).toMatch(/::warning::Could not fetch a cat image: Error: cat api responded with (302|a redirect)/)
    expect(postedComments()).toEqual([fallback])
  })

  // the url checks are unit-tested in __tests__/issueCommentTest/meow.test.ts; one row proves the bundle applies them
  it('falls back to the note when the cat api returns a url on another host', async () => {
    cat.answer({ status: 200, body: [{ url: 'https://evil.example/cat.jpg' }] })
    gh.route('POST', `${repo}/issues/1/comments`, { status: 201, body: {} })

    const result = await meow('/meow')

    expect(result.status, result.stdout).toBe(0)
    expect(cat.requests).toHaveLength(1)
    expect(result.stdout).toContain('::warning::Could not fetch a cat image: Error: cat api returned an image from an unexpected host')
    expect(postedComments()).toEqual([fallback])
  })

  it('ignores /meow inside a fenced code block without calling either api', async () => {
    const result = await meow('```\n/meow\n```')

    expect(result.status, result.stdout).toBe(0)
    expect(result.errors).toEqual([])
    expect(cat.requests).toEqual([])
    expect(calls()).toEqual([])
  })

  it('fails the run when github refuses the comment', async () => {
    cat.answer({ status: 200, body: [{ url: image }] })
    gh.route('POST', `${repo}/issues/1/comments`, { status: 500, body: { message: 'boom' } })

    const result = await meow('/meow')

    expect(result.status, result.stdout).toBe(1)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toMatch(/error handling issue comment/)
    expect(calls()).toEqual([`POST ${repo}/issues/1/comments`])
  })
})
