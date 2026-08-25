import * as core from '@actions/core'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'

import { handleIssueComment } from '../../src/issueComment/handleIssueComment'
import { meowConfig } from '../../src/issueComment/meow'
import * as comments from '../../src/utils/comments'
import issueCommentEvent from '../fixtures/issues/issueCommentEvent.json'
import * as utils from '../testUtils'

const catApi = 'https://api.thecatapi.com/v1/images/search'

const server = setupServer()
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterEach(() => {
  server.resetHandlers()
  jest.restoreAllMocks()
})
afterAll(() => server.close())

function contextFor(body: string) {
  issueCommentEvent.comment.body = body
  return new utils.MockContext(issueCommentEvent)
}

describe('/meow', () => {
  let createComment: jest.SpiedFunction<typeof comments.createComment>

  beforeEach(() => {
    utils.setupActionsEnv('/meow')
    meowConfig.timeoutMs = 10_000
    meowConfig.retryDelayMs = 0
    meowConfig.maxAttempts = 3
    createComment = jest.spyOn(comments, 'createComment').mockResolvedValue()
  })

  it('comments with a cat image for a standalone /meow', async () => {
    server.use(
      http.get(catApi, () =>
        HttpResponse.json([{ url: 'https://cataas.com/cat.jpg' }])),
    )

    await handleIssueComment(contextFor('/meow'))

    expect(createComment).toHaveBeenCalledTimes(1)
    expect(createComment).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      1,
      '![cat](<https://cataas.com/cat.jpg>)',
    )
  })

  it('safely renders a url that contains parentheses', async () => {
    const url = 'https://example.test/cats/a_(b).jpg'
    server.use(http.get(catApi, () => HttpResponse.json([{ url }])))

    await handleIssueComment(contextFor('/meow'))

    expect(createComment).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      1,
      `![cat](<${url}>)`,
    )
  })

  it.each(['/meowvie', '/meow-debug', '/meow cat', 'please run /meow later'])(
    'does not trigger for %p',
    async (body) => {
      await handleIssueComment(contextFor(body))
      expect(createComment).not.toHaveBeenCalled()
    },
  )

  it('matches a standalone /meow once in a CRLF comment', async () => {
    server.use(
      http.get(catApi, () =>
        HttpResponse.json([{ url: 'https://cataas.com/cat.jpg' }])),
    )

    await handleIssueComment(contextFor('/meow\r\n/something-else'))

    expect(createComment).toHaveBeenCalledTimes(1)
  })

  it('retries a transient status and then succeeds', async () => {
    let calls = 0
    server.use(
      http.get(catApi, () => {
        calls++
        if (calls === 1)
          return new HttpResponse(null, { status: 503 })
        return HttpResponse.json([{ url: 'https://cataas.com/cat.jpg' }])
      }),
    )

    await handleIssueComment(contextFor('/meow'))

    expect(calls).toBe(2)
    expect(createComment).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      1,
      '![cat](<https://cataas.com/cat.jpg>)',
    )
  })

  it('degrades to a note when the cat api keeps failing', async () => {
    let calls = 0
    server.use(
      http.get(catApi, () => {
        calls++
        return new HttpResponse(null, { status: 500 })
      }),
    )
    const warning = jest.spyOn(core, 'warning').mockImplementation(() => {})

    await handleIssueComment(contextFor('/meow'))

    expect(calls).toBe(meowConfig.maxAttempts)
    expect(warning).toHaveBeenCalled()
    expect(createComment).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      1,
      'The cat API is unavailable right now.',
    )
  })

  it('degrades to a note on a network error', async () => {
    server.use(http.get(catApi, () => HttpResponse.error()))
    jest.spyOn(core, 'warning').mockImplementation(() => {})

    await handleIssueComment(contextFor('/meow'))

    expect(createComment).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      1,
      'The cat API is unavailable right now.',
    )
  })

  it('degrades to a note when the cat api times out and does not retry', async () => {
    meowConfig.timeoutMs = 50
    let calls = 0
    server.use(
      http.get(catApi, () => {
        calls++
        return new Promise(() => {})
      }),
    )
    jest.spyOn(core, 'warning').mockImplementation(() => {})

    await handleIssueComment(contextFor('/meow'))

    expect(calls).toBe(1)
    expect(createComment).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      1,
      'The cat API is unavailable right now.',
    )
  })

  it('degrades to a note when the response has no usable url', async () => {
    server.use(http.get(catApi, () => HttpResponse.json([])))
    jest.spyOn(core, 'warning').mockImplementation(() => {})

    await handleIssueComment(contextFor('/meow'))

    expect(createComment).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      1,
      'The cat API is unavailable right now.',
    )
  })

  it('sends the api key header only when configured', async () => {
    process.env['INPUT_CAT-API-KEY'] = 'secret-key'
    const setSecret = jest.spyOn(core, 'setSecret').mockImplementation(() => {})
    let seenKey: string | null = null
    server.use(
      http.get(catApi, ({ request }) => {
        seenKey = request.headers.get('x-api-key')
        return HttpResponse.json([{ url: 'https://cataas.com/cat.jpg' }])
      }),
    )

    await handleIssueComment(contextFor('/meow'))

    expect(setSecret).toHaveBeenCalledWith('secret-key')
    expect(seenKey).toBe('secret-key')
  })

  it('fails the action when the github comment write fails', async () => {
    server.use(
      http.get(catApi, () =>
        HttpResponse.json([{ url: 'https://cataas.com/cat.jpg' }])),
    )
    createComment.mockRejectedValue(new Error('could not add comment: boom'))
    const setFailed = jest.spyOn(core, 'setFailed').mockImplementation(() => {})

    await handleIssueComment(contextFor('/meow'))

    expect(setFailed).toHaveBeenCalledWith(
      expect.stringContaining('could not add comment'),
    )
  })

  it('does not send an api key header when none is configured', async () => {
    let sentKey: boolean | null = null
    server.use(
      http.get(catApi, ({ request }) => {
        sentKey = request.headers.has('x-api-key')
        return HttpResponse.json([{ url: 'https://cataas.com/cat.jpg' }])
      }),
    )

    await handleIssueComment(contextFor('/meow'))

    expect(sentKey).toBe(false)
  })

  it('does not retry a client error', async () => {
    let calls = 0
    server.use(
      http.get(catApi, () => {
        calls++
        return new HttpResponse(null, { status: 400 })
      }),
    )
    jest.spyOn(core, 'warning').mockImplementation(() => {})

    await handleIssueComment(contextFor('/meow'))

    expect(calls).toBe(1)
    expect(createComment).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      1,
      'The cat API is unavailable right now.',
    )
  })

  it('requests a single medium image', async () => {
    let requestedUrl: string | null = null
    server.use(
      http.get(catApi, ({ request }) => {
        requestedUrl = request.url
        return HttpResponse.json([{ url: 'https://cataas.com/cat.jpg' }])
      }),
    )

    await handleIssueComment(contextFor('/meow'))

    expect(requestedUrl).toContain('limit=1')
    expect(requestedUrl).toContain('size=med')
  })

  it('retries a network error up to the attempt limit', async () => {
    let calls = 0
    server.use(
      http.get(catApi, () => {
        calls++
        return HttpResponse.error()
      }),
    )
    jest.spyOn(core, 'warning').mockImplementation(() => {})

    await handleIssueComment(contextFor('/meow'))

    expect(calls).toBe(meowConfig.maxAttempts)
  })

  it('degrades to a note for a non-https image url', async () => {
    server.use(
      http.get(catApi, () =>
        HttpResponse.json([{ url: 'http://cataas.com/cat.jpg' }])),
    )
    jest.spyOn(core, 'warning').mockImplementation(() => {})

    await handleIssueComment(contextFor('/meow'))

    expect(createComment).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      1,
      'The cat API is unavailable right now.',
    )
  })

  it('degrades to a note for a url that embeds credentials', async () => {
    server.use(
      http.get(catApi, () =>
        HttpResponse.json([{ url: 'https://user:pass@cataas.com/cat.jpg' }])),
    )
    jest.spyOn(core, 'warning').mockImplementation(() => {})

    await handleIssueComment(contextFor('/meow'))

    expect(createComment).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      1,
      'The cat API is unavailable right now.',
    )
  })

  it('does not follow a redirect or forward the key', async () => {
    process.env['INPUT_CAT-API-KEY'] = 'secret-key'
    // the redirect target is intentionally not mocked: onUnhandledRequest error
    // fails the test if the request is ever followed there
    server.use(
      http.get(catApi, () =>
        new HttpResponse(null, {
          status: 302,
          headers: { location: 'https://redirect.example/cat' },
        })),
    )
    jest.spyOn(core, 'warning').mockImplementation(() => {})

    await handleIssueComment(contextFor('/meow'))

    expect(createComment).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      1,
      'The cat API is unavailable right now.',
    )
  })

  it('degrades to a note when the first item has no url', async () => {
    server.use(http.get(catApi, () => HttpResponse.json([{}])))
    jest.spyOn(core, 'warning').mockImplementation(() => {})

    await handleIssueComment(contextFor('/meow'))

    expect(createComment).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      1,
      'The cat API is unavailable right now.',
    )
  })

  it('degrades to a note when the url does not parse', async () => {
    server.use(
      http.get(catApi, () => HttpResponse.json([{ url: 'not a url' }])),
    )
    jest.spyOn(core, 'warning').mockImplementation(() => {})

    await handleIssueComment(contextFor('/meow'))

    expect(createComment).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      1,
      'The cat API is unavailable right now.',
    )
  })

  it('degrades to a note for an excessively long url', async () => {
    const longUrl = `https://cataas.com/${'a'.repeat(5000)}.jpg`
    server.use(http.get(catApi, () => HttpResponse.json([{ url: longUrl }])))
    jest.spyOn(core, 'warning').mockImplementation(() => {})

    await handleIssueComment(contextFor('/meow'))

    expect(createComment).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      1,
      'The cat API is unavailable right now.',
    )
  })

  it('does not retry a rate limit', async () => {
    let calls = 0
    server.use(
      http.get(catApi, () => {
        calls++
        return new HttpResponse(null, { status: 429 })
      }),
    )
    jest.spyOn(core, 'warning').mockImplementation(() => {})

    await handleIssueComment(contextFor('/meow'))

    expect(calls).toBe(1)
    expect(createComment).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      1,
      'The cat API is unavailable right now.',
    )
  })

  it('cancels the response body before retrying', async () => {
    let cancelled = false
    const stream = new ReadableStream({
      cancel() {
        cancelled = true
      },
    })
    jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response(stream, { status: 503 }))
      .mockResolvedValueOnce(
        Response.json([{ url: 'https://cataas.com/cat.jpg' }]),
      )

    await handleIssueComment(contextFor('/meow'))

    expect(cancelled).toBe(true)
    expect(createComment).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      1,
      '![cat](<https://cataas.com/cat.jpg>)',
    )
  })

  it('cancels the response body for a non-retryable status', async () => {
    let cancelled = false
    const stream = new ReadableStream({
      cancel() {
        cancelled = true
      },
    })
    jest
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(new Response(stream, { status: 400 }))
    jest.spyOn(core, 'warning').mockImplementation(() => {})

    await handleIssueComment(contextFor('/meow'))

    expect(cancelled).toBe(true)
  })
})
