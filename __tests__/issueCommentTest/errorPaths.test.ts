import { http } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { assign } from '../../src/issueComment/assign'
import { cc } from '../../src/issueComment/cc'
import { close } from '../../src/issueComment/close'
import { lock } from '../../src/issueComment/lock'
import { reopen } from '../../src/issueComment/reopen'
import { retitle } from '../../src/issueComment/retitle'
import { unassign } from '../../src/issueComment/unassign'
import { uncc } from '../../src/issueComment/uncc'
import * as auth from '../../src/utils/auth'

import issueCommentEvent from '../fixtures/issues/issueCommentEvent.json'
import * as utils from '../testUtils'

// the auth helpers swallow HTTP failures themselves, so the handlers' own
// "could not check auth" branches are only reachable when the helper rejects
vi.mock('../../src/utils/auth', { spy: true })

const server = setupServer()
beforeAll(() =>
  server.listen({
    onUnhandledRequest: 'error',
  }),
)
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

const issue = `${utils.api}/repos/Codertocat/Hello-World/issues/1`
const pull = `${utils.api}/repos/Codertocat/Hello-World/pulls/1`
const forbidden = { message: 'Resource not accessible by integration' }
const author = issueCommentEvent.issue.user.login
const stranger = 'not-the-author'

function comment(body: string, commenter = author) {
  const payload = structuredClone(issueCommentEvent)
  payload.comment.body = body
  payload.comment.user.login = commenter
  return new utils.MockContext(payload)
}

function commentWithoutIssue(body: string) {
  const context = comment(body)
  delete context.payload.issue
  return context
}

function failing(method: 'get' | 'post' | 'patch' | 'put' | 'delete', url: string) {
  server.use(http[method](url, utils.mockResponse(403, forbidden)))
}

beforeEach(() => {
  utils.setupActionsEnv()
})

describe('/assign error paths', () => {
  it('throws when the payload has no issue number', async () => {
    await expect(assign(commentWithoutIssue('/assign'))).rejects.toThrow(
      /missing issue number/,
    )
  })

  it('wraps a failed self assignment', async () => {
    vi.mocked(auth.checkCommenterAuth).mockResolvedValueOnce(true)
    failing('post', `${issue}/assignees`)

    await expect(assign(comment('/assign'))).rejects.toThrow(/could not self assign/)
  })

  it('wraps a failed authorization lookup', async () => {
    vi.mocked(auth.getOrgCollabCommentUsers).mockRejectedValueOnce(new Error('lookup exploded'))

    await expect(assign(comment('/assign @some-user'))).rejects.toThrow(
      /could not get authorized users: Error: lookup exploded/,
    )
  })

  it('wraps a failed assignment of authorized users', async () => {
    vi.mocked(auth.getOrgCollabCommentUsers).mockResolvedValueOnce(['some-user'])
    failing('post', `${issue}/assignees`)

    await expect(assign(comment('/assign @some-user'))).rejects.toThrow(/could not add assignees/)
  })
})

describe('/unassign error paths', () => {
  it('throws when the payload has no issue number', async () => {
    await expect(unassign(commentWithoutIssue('/unassign'))).rejects.toThrow(
      /missing issue number/,
    )
  })

  it('wraps a failed self unassignment', async () => {
    failing('delete', `${issue}/assignees`)

    await expect(unassign(comment('/unassign'))).rejects.toThrow(/could not remove assignee/)
  })

  it('wraps a failed commenter authorization check', async () => {
    vi.mocked(auth.checkCommenterAuth).mockRejectedValueOnce(new Error('auth exploded'))

    await expect(unassign(comment('/unassign @some-user'))).rejects.toThrow(
      /Error: auth exploded/,
    )
  })

  it('wraps a failed unassignment of another user', async () => {
    vi.mocked(auth.checkCommenterAuth).mockResolvedValueOnce(true)
    failing('delete', `${issue}/assignees`)

    await expect(unassign(comment('/unassign @some-user'))).rejects.toThrow(
      /could not remove assignee/,
    )
  })
})

describe('/cc error paths', () => {
  it('throws when the payload has no pull number', async () => {
    await expect(cc(commentWithoutIssue('/cc'))).rejects.toThrow(/missing pull number/)
  })

  it('wraps a failed self review request', async () => {
    vi.mocked(auth.checkCollaborator).mockResolvedValueOnce(true)
    failing('post', `${pull}/requested_reviewers`)

    await expect(cc(comment('/cc'))).rejects.toThrow(/could not self cc/)
  })

  it('wraps a failed authorization lookup', async () => {
    vi.mocked(auth.getOrgCollabCommentUsers).mockRejectedValueOnce(new Error('lookup exploded'))

    await expect(cc(comment('/cc @some-user'))).rejects.toThrow(
      /could not get authorized users: Error: lookup exploded/,
    )
  })

  it('wraps a failed review request for authorized users', async () => {
    vi.mocked(auth.getOrgCollabCommentUsers).mockResolvedValueOnce(['some-user'])
    failing('post', `${pull}/requested_reviewers`)

    await expect(cc(comment('/cc @some-user'))).rejects.toThrow(/could not request reviewers/)
  })
})

describe('/uncc error paths', () => {
  it('throws when the payload has no pull number', async () => {
    await expect(uncc(commentWithoutIssue('/uncc'))).rejects.toThrow(/missing pull number/)
  })

  it('wraps a failed self review removal', async () => {
    vi.mocked(auth.checkCollaborator).mockResolvedValueOnce(true)
    failing('delete', `${pull}/requested_reviewers`)

    await expect(uncc(comment('/uncc'))).rejects.toThrow(/could not self uncc/)
  })

  it('wraps a failed commenter authorization check', async () => {
    vi.mocked(auth.checkCommenterAuth).mockRejectedValueOnce(new Error('auth exploded'))

    await expect(uncc(comment('/uncc @some-user'))).rejects.toThrow(
      /could not get authorized users: Error: auth exploded/,
    )
  })
})

describe('/reopen error paths', () => {
  it('throws when the payload has no issue number', async () => {
    await expect(reopen(commentWithoutIssue('/reopen'))).rejects.toThrow(
      /missing issue number/,
    )
  })

  it('wraps a failed collaborator check for a non-author', async () => {
    vi.mocked(auth.checkCollaborator).mockRejectedValueOnce(new Error('auth exploded'))

    await expect(reopen(comment('/reopen', stranger))).rejects.toThrow(
      /could not check commentor auth: Error: auth exploded/,
    )
  })

  it('wraps a failed reopen', async () => {
    failing('patch', issue)

    await expect(reopen(comment('/reopen'))).rejects.toThrow(/could not open issue/)
  })
})

describe('/close error paths', () => {
  it('throws when the payload has no issue number', async () => {
    await expect(close(commentWithoutIssue('/close'))).rejects.toThrow(
      /missing issue number/,
    )
  })

  it('wraps a failed collaborator check for a non-author', async () => {
    vi.mocked(auth.checkCollaborator).mockRejectedValueOnce(new Error('auth exploded'))

    await expect(close(comment('/close', stranger))).rejects.toThrow(
      /could not check commentor auth: Error: auth exploded/,
    )
  })

  it('wraps a failed close', async () => {
    failing('patch', issue)

    await expect(close(comment('/close'))).rejects.toThrow(/could not close issue/)
  })
})

describe('/retitle error paths', () => {
  it('throws when the payload has no issue number', async () => {
    await expect(retitle(commentWithoutIssue('/retitle new title'))).rejects.toThrow(
      /missing issue number/,
    )
  })

  it('wraps a failed collaborator check', async () => {
    vi.mocked(auth.checkCollaborator).mockRejectedValueOnce(new Error('auth exploded'))

    await expect(retitle(comment('/retitle new title'))).rejects.toThrow(
      /could not check Commentor auth: Error: auth exploded/,
    )
  })

  it('wraps a failed title update', async () => {
    vi.mocked(auth.checkCollaborator).mockResolvedValueOnce(true)
    failing('patch', issue)

    await expect(retitle(comment('/retitle new title'))).rejects.toThrow(
      /could not update issue/,
    )
  })
})

describe('/lock error paths', () => {
  it('throws when the payload has no issue number', async () => {
    await expect(lock(commentWithoutIssue('/lock'))).rejects.toThrow(/missing issue number/)
  })

  it('wraps a failed collaborator check', async () => {
    vi.mocked(auth.checkCollaborator).mockRejectedValueOnce(new Error('auth exploded'))

    await expect(lock(comment('/lock'))).rejects.toThrow(
      /could not check commenter auth: Error: auth exploded/,
    )
  })

  it('wraps a failed lock', async () => {
    vi.mocked(auth.checkCollaborator).mockResolvedValueOnce(true)
    failing('put', `${issue}/lock`)

    await expect(lock(comment('/lock'))).rejects.toThrow(/could not lock issue/)
  })
})
