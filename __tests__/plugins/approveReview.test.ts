import type { ApprovalEvent, ApprovalState, ApproveSettings } from '../../src/plugins/approve'
import type { PullRequestOwners } from '../../src/utils/pullRequestOwners'

import { Buffer } from 'node:buffer'
import * as core from '@actions/core'
import { http } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { approveOnPullRequest, approveOnReview } from '../../src/plugins/approve'
import { forbiddenWarning, isOwnReview, notPermittedWarning, reviewBody, reviewMarker, syncApprovalReview, tokenIdentity, withdrawalReason } from '../../src/plugins/approveReview'
import { handlePullReq } from '../../src/pullReq/handlePullReq'
import { handlePullReqReview } from '../../src/pullReq/handlePullReqReview'
import labelFileContents from '../fixtures/labels/labelFileContentsResp.json'
import pullReqOpenedEvent from '../fixtures/pullReq/pullReqOpenedEvent.json'
import reviewSubmittedEvent from '../fixtures/pullReq/pullReqReviewSubmittedEvent.json'
import * as utils from '../testUtils'
import { prHandlers, pullBody, repo } from '../utils/ownersFixtures'

const server = setupServer()
beforeAll(() => server.listen(utils.failOnUnhandledRequest))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

const twoDirs = {
  'OWNERS': 'approvers:\n- alice\n',
  'sdk/OWNERS': 'approvers:\n- bob\n',
  'olm/OWNERS': 'options:\n  no_parent_owners: true\napprovers:\n- carol\n',
}
const twoFiles = ['sdk/x.go', 'olm/y.go']
const on = 'approve:\n  github_review: true\n'
const head = pullBody.head.sha

interface Actor { login: string, type?: string }
interface CommentFixture { id?: number, body: string, user: Actor }
interface ReviewFixture { id?: number, state: string, user: Actor, body?: string, commit_id?: string }

const bot: Actor = { login: 'github-actions[bot]', type: 'Bot' }
const approveBy = (login: string): CommentFixture => ({ body: '/approve', user: { login } })
const mirrored = (overrides: Partial<ReviewFixture> = {}): ReviewFixture => ({ state: 'APPROVED', user: bot, body: `Approved via /approve by bob, carol (OWNERS).\n${reviewMarker}`, commit_id: head, ...overrides })

interface Scenario {
  owners?: Record<string, string>
  files?: string[]
  author?: string
  labels?: string[]
  comments?: CommentFixture[]
  reviews?: ReviewFixture[]
  prowYaml?: string
  /** `GET /user`: a login for a user token, a status for an installation token or a failure */
  user?: string | number
  /** the answer to `POST /pulls/1/reviews` */
  createReview?: { status: number, body?: unknown }
  dismissStatus?: number
  pull?: Record<string, unknown>
}

function stamp(index: number): string {
  return new Date(Date.UTC(2024, 0, 1, 0, 0, index)).toISOString()
}

// one approval evaluation; every write is recorded in order
function serve(scenario: Scenario = {}) {
  const {
    owners = twoDirs,
    files = twoFiles,
    author = 'some-author',
    labels = [],
    comments = [],
    reviews = [],
    prowYaml = on,
    user = 403,
    createReview = { status: 200, body: { id: 999 } },
    dismissStatus = 200,
    pull = {},
  } = scenario

  const calls: string[] = []
  const created: Record<string, unknown>[] = []
  const dismissed: { id: string, body: Record<string, unknown> }[] = []
  const userRead = new utils.ObserveRequest()
  const listReviews = new utils.ObserveRequest()

  const configFile = structuredClone(labelFileContents)
  configFile.content = Buffer.from(prowYaml).toString('base64')

  server.use(
    ...utils.noOrgOrRepoConfigExcept(...(prowYaml === '' ? [] : ['.github/prow.yaml'])),
    ...(prowYaml === '' ? [] : [http.get(utils.contentsUrl('.github/prow.yaml'), utils.mockResponse(200, configFile))]),
    ...prHandlers(owners, files, { user: { login: author }, labels: labels.map(name => ({ name })), ...pull }),
    utils.defaultBranchTree(Object.keys(owners)),
    utils.repoHasLabels(['approved', 'lgtm']),
    http.get(`${utils.api}/user`, typeof user === 'string'
      ? utils.mockResponse(200, { login: user, type: 'User' }, userRead)
      : utils.mockResponse(user, { message: 'Resource not accessible by integration' }, userRead)),
    http.get(`${repo}/issues/1/comments`, utils.mockResponse(200, comments.map((c, i) => ({ id: c.id ?? 100 + i, created_at: stamp(i + 1), ...c })))),
    http.get(`${repo}/pulls/1/reviews`, utils.mockResponse(200, reviews.map((r, i) => ({ id: r.id ?? 200 + i, submitted_at: stamp(i + 1), ...r })), listReviews)),
    http.post(`${repo}/issues/1/labels`, () => {
      calls.push('label')
      return Response.json([])
    }),
    http.delete(`${repo}/issues/1/labels/approved`, () => {
      calls.push('unlabel')
      return Response.json([])
    }),
    http.post(`${repo}/issues/1/comments`, () => {
      calls.push('notifier')
      return Response.json({}, { status: 201 })
    }),
    http.patch(`${repo}/issues/comments/:id`, () => {
      calls.push('notifier')
      return Response.json({})
    }),
    http.post(`${repo}/pulls/1/reviews`, async ({ request }) => {
      calls.push('review')
      created.push(await request.json() as Record<string, unknown>)
      return Response.json(createReview.body ?? null, { status: createReview.status })
    }),
    http.put(`${repo}/pulls/1/reviews/:id/dismissals`, async ({ request, params }) => {
      calls.push('dismiss')
      dismissed.push({ id: String(params.id), body: await request.json() as Record<string, unknown> })
      return Response.json(dismissStatus === 200 ? {} : { message: 'Server Error' }, { status: dismissStatus })
    }),
  )

  return { calls, created, dismissed, userRead, listReviews }
}

function prEvent(action: string) {
  return new utils.MockContext({ ...pullReqOpenedEvent, action })
}

function reviewEvent(action: string, review: Record<string, unknown> = {}) {
  return new utils.MockContext({ ...reviewSubmittedEvent, action, review: { ...reviewSubmittedEvent.review, ...review } })
}

let setFailed: ReturnType<typeof vi.spyOn>
let warning: ReturnType<typeof vi.spyOn>
let debug: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  utils.setupActionsEnv()
  setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})
  warning = vi.spyOn(core, 'warning').mockImplementation(() => {})
  debug = vi.spyOn(core, 'debug')
})

describe('approve.github_review off (the default)', () => {
  it('approved: no GET /user, no review written, the label and notifier as before', async () => {
    const writes = serve({ prowYaml: '', comments: [approveBy('bob'), approveBy('carol')] })

    await approveOnPullRequest(prEvent('opened'))

    expect(writes.calls).toEqual(['label', 'notifier'])
    await expect(writes.userRead.notCalled()).resolves.toBe('not called')
    expect(writes.created).toEqual([])
  })

  it('not approved, with an earlier mirrored review on the pull request: nothing is dismissed', async () => {
    const writes = serve({ prowYaml: 'approve:\n  github_review: false\n', labels: ['approved'], reviews: [mirrored()] })

    await approveOnPullRequest(prEvent('synchronize'))

    expect(writes.calls).toEqual(['unlabel', 'notifier'])
    await expect(writes.userRead.notCalled()).resolves.toBe('not called')
  })

  it('with ignore_review_state not even the reviews are listed', async () => {
    const writes = serve({ prowYaml: 'approve:\n  ignore_review_state: true\n', comments: [approveBy('bob'), approveBy('carol')] })

    await approveOnPullRequest(prEvent('opened'))

    expect(writes.calls).toEqual(['label', 'notifier'])
    await expect(writes.listReviews.notCalled()).resolves.toBe('not called')
    await expect(writes.userRead.notCalled()).resolves.toBe('not called')
  })

  it('a review carrying the marker never counts as an approval, even with the setting off', async () => {
    const writes = serve({ prowYaml: '', author: 'carol', reviews: [mirrored({ user: { login: 'bob', type: 'User' } })] })

    await approveOnPullRequest(prEvent('opened'))

    expect(writes.calls).toEqual(['notifier'])
  })
})

describe('approve.github_review: approved', () => {
  it('submits one APPROVE review on the head commit, after the label and before nothing else', async () => {
    const writes = serve({ comments: [approveBy('bob'), approveBy('carol')] })

    await approveOnPullRequest(prEvent('opened'))

    expect(writes.calls).toEqual(['label', 'notifier', 'review'])
    expect(writes.created).toEqual([{
      commit_id: head,
      event: 'APPROVE',
      body: reviewBody({ approvers: new Set(['bob', 'carol']) } as ApprovalState),
    }])
    expect(writes.created[0].body).toContain('Approved via /approve by bob, carol (OWNERS).')
    expect(writes.created[0].body).toContain(reviewMarker)
    expect(writes.created[0].body).not.toContain('@')
    expect(setFailed).not.toHaveBeenCalled()
  })

  it('is idempotent: the review on the head exists, so a re-run writes nothing', async () => {
    const writes = serve({ labels: ['approved'], comments: [approveBy('bob'), approveBy('carol')], reviews: [mirrored()] })

    await approveOnPullRequest(prEvent('synchronize'))

    expect(writes.created).toEqual([])
    expect(writes.dismissed).toEqual([])
    expect(debug).toHaveBeenCalledWith(`approve: #1 already carries the approval review on ${head}`)
  })

  it('synchronize: the review on the old head stays, a fresh one is submitted on the new head', async () => {
    const writes = serve({ labels: ['approved'], comments: [approveBy('bob'), approveBy('carol')], reviews: [mirrored({ id: 7, commit_id: 'oldsha' })] })

    await approveOnPullRequest(prEvent('synchronize'))

    expect(writes.created).toHaveLength(1)
    expect(writes.created[0].commit_id).toBe(head)
    expect(writes.dismissed).toEqual([])
  })

  it('a mirrored review that GitHub dismissed as stale does not count as present', async () => {
    const writes = serve({ labels: ['approved'], comments: [approveBy('bob'), approveBy('carol')], reviews: [mirrored({ state: 'DISMISSED' })] })

    await approveOnPullRequest(prEvent('synchronize'))

    expect(writes.created).toHaveLength(1)
  })

  it('an approving review by someone else on the head, marker included, is not the bot\'s', async () => {
    const writes = serve({ labels: ['approved'], comments: [approveBy('bob'), approveBy('carol')], reviews: [mirrored({ user: { login: 'mallory', type: 'User' } })] })

    await approveOnPullRequest(prEvent('synchronize'))

    expect(writes.created).toHaveLength(1)
  })

  it('a pull request opened by the token\'s own user: warning, no review', async () => {
    const writes = serve({ user: 'Prow-Bot', author: 'prow-bot', comments: [approveBy('bob'), approveBy('carol')] })

    await approveOnPullRequest(prEvent('opened'))

    expect(writes.calls).toEqual(['label', 'notifier'])
    expect(warning).toHaveBeenCalledWith('cannot submit the approval review: #1 was opened by the token\'s own identity (prow-bot), and GitHub does not let an author approve their own pull request (approve.github_review)')
    expect(setFailed).not.toHaveBeenCalled()
  })

  it('github refusing a self-approval with 422: warning, not failure', async () => {
    const writes = serve({
      author: 'github-actions[bot]',
      comments: [approveBy('bob'), approveBy('carol')],
      createReview: { status: 422, body: { message: 'Unprocessable Entity', errors: ['Can not approve your own pull request'] } },
    })

    await expect(approveOnPullRequest(prEvent('opened'))).resolves.toBeUndefined()

    expect(writes.created).toHaveLength(1)
    expect(warning).toHaveBeenCalledWith('cannot submit the approval review: #1 was opened by the token\'s own identity (github-actions[bot]), and GitHub does not let an author approve their own pull request (approve.github_review)')
  })

  it('a plain 403: warning naming the missing permission, not the repository setting, not failure', async () => {
    serve({
      comments: [approveBy('bob'), approveBy('carol')],
      createReview: { status: 403, body: { message: 'Resource not accessible by integration' } },
    })

    await expect(approveOnPullRequest(prEvent('opened'))).resolves.toBeUndefined()

    expect(warning).toHaveBeenCalledWith(`${forbiddenWarning}: Resource not accessible by integration`)
    expect(warning).not.toHaveBeenCalledWith(expect.stringContaining('Allow GitHub Actions'))
    expect(forbiddenWarning).toBe('cannot submit the approval review: the token was refused; grant the workflow `pull-requests: write` (approve.github_review)')
  })

  it('"GitHub Actions is not permitted to approve pull requests." whatever the status: warning naming the repository setting', async () => {
    for (const status of [422, 403]) {
      warning.mockClear()
      serve({
        comments: [approveBy('bob'), approveBy('carol')],
        createReview: { status, body: { message: 'GitHub Actions is not permitted to approve pull requests.' } },
      })

      await expect(approveOnPullRequest(prEvent('opened'))).resolves.toBeUndefined()

      expect(warning).toHaveBeenCalledWith(`${notPermittedWarning}: GitHub Actions is not permitted to approve pull requests.`)
      expect(notPermittedWarning).toBe('cannot submit the approval review: enable "Allow GitHub Actions to create and approve pull requests" (Settings → Actions → General) or pass a token that can (approve.github_review)')
      server.resetHandlers()
      utils.setupActionsEnv()
    }
  })

  it('any other API error fails the evaluation after the label and the notifier were written', async () => {
    const writes = serve({ comments: [approveBy('bob'), approveBy('carol')], createReview: { status: 500, body: { message: 'Server Error' } } })

    await expect(approveOnPullRequest(prEvent('opened'))).rejects.toThrow('could not submit the approval review: HttpError: Server Error')

    expect(writes.calls).toEqual(['label', 'notifier', 'review'])
  })

  it('a draft pull request gets no review until it is ready for review', async () => {
    const draft = serve({ comments: [approveBy('bob'), approveBy('carol')], pull: { draft: true } })

    await approveOnPullRequest(prEvent('opened'))

    expect(draft.calls).toEqual(['label', 'notifier'])
    expect(draft.created).toEqual([])
    expect(debug).toHaveBeenCalledWith('approve: #1 is a draft; no approval review is submitted until it is ready for review')

    server.resetHandlers()
    utils.setupActionsEnv()
    const ready = serve({ labels: ['approved'], comments: [approveBy('bob'), approveBy('carol')] })

    await approveOnPullRequest(prEvent('ready_for_review'))

    expect(ready.created).toHaveLength(1)
    expect(ready.created[0].commit_id).toBe(head)
  })

  it('a draft that loses approved still has its mirrored review dismissed', async () => {
    const writes = serve({ labels: ['approved'], reviews: [mirrored({ id: 9 })], pull: { draft: true } })

    await approveOnPullRequest(prEvent('synchronize'))

    expect(writes.calls).toEqual(['unlabel', 'notifier', 'dismiss'])
    expect(writes.dismissed.map(d => d.id)).toEqual(['9'])
  })

  it('a closed pull request gets no review', async () => {
    const writes = serve({ comments: [approveBy('bob'), approveBy('carol')], pull: { state: 'closed' } })

    await approveOnReview(reviewEvent('submitted'))

    expect(writes.calls).toEqual(['label', 'notifier'])
    expect(debug).toHaveBeenCalledWith('approve: #1 is not open; its approval review is left alone')
  })

  it('ignore_review_state: the reviews are listed for the mirror but still do not count', async () => {
    const writes = serve({
      prowYaml: 'approve:\n  github_review: true\n  ignore_review_state: true\n',
      author: 'carol',
      reviews: [{ state: 'APPROVED', user: { login: 'bob' } }],
    })

    await approveOnPullRequest(prEvent('opened'))

    await expect(writes.listReviews.called()).resolves.toBe('called')
    expect(writes.calls).toEqual(['notifier'])
  })
})

describe('approve.github_review: not approved', () => {
  it('/approve cancel dismisses every mirrored review, on any commit, with the reason', async () => {
    const writes = serve({
      labels: ['approved'],
      comments: [approveBy('bob'), approveBy('carol'), { body: '/approve cancel', user: { login: 'bob' } }],
      reviews: [mirrored({ id: 7, commit_id: 'oldsha' }), mirrored({ id: 8 })],
    })

    await approveOnPullRequest(prEvent('synchronize'))

    expect(writes.calls).toEqual(['unlabel', 'notifier', 'dismiss', 'dismiss'])
    const message = 'approved removed: no approver covers sdk/x.go; withdrawn by bob (/approve cancel)'
    expect(writes.dismissed).toEqual([{ id: '7', body: { message } }, { id: '8', body: { message } }])
    expect(writes.created).toEqual([])
  })

  it('reviews without the marker, by anyone, and reviews by others carrying it are never dismissed', async () => {
    const writes = serve({
      labels: ['approved'],
      author: 'carol',
      reviews: [
        { state: 'APPROVED', user: bot, commit_id: head },
        { state: 'APPROVED', user: { login: 'dave', type: 'User' }, commit_id: head },
        mirrored({ user: { login: 'mallory', type: 'User' } }),
        { state: 'CHANGES_REQUESTED', user: { login: 'bob' } },
      ],
    })

    await approveOnPullRequest(prEvent('synchronize'))

    expect(writes.calls).toEqual(['unlabel', 'notifier'])
    expect(debug).toHaveBeenCalledWith('approve: #1 carries no approval review to dismiss')
  })

  it('a CHANGES_REQUESTED review names the reviewer', async () => {
    const writes = serve({
      labels: ['approved'],
      author: 'carol',
      comments: [approveBy('bob')],
      reviews: [mirrored({ id: 9 }), { state: 'CHANGES_REQUESTED', user: { login: 'bob' } }],
    })

    await approveOnReview(reviewEvent('submitted'))

    expect(writes.dismissed).toEqual([{ id: '9', body: { message: 'approved removed: no approver covers sdk/x.go; withdrawn by bob (changes requested)' } }])
  })

  it('a refused dismissal fails the evaluation', async () => {
    serve({ labels: ['approved'], reviews: [mirrored({ id: 9 })], dismissStatus: 500 })

    await expect(approveOnPullRequest(prEvent('synchronize'))).rejects.toThrow('could not dismiss the approval review 9: HttpError: Server Error')
  })
})

describe('approve.github_review: the bot\'s own review never approves (user token)', () => {
  // prow-bot is an OWNERS approver of every file: if its review counted, approved would hold itself up
  const botApprover = { OWNERS: 'approvers:\n- prow-bot\n' }

  it('the mirrored review by the token\'s user is not an approval: approved goes, the review is dismissed', async () => {
    const writes = serve({
      owners: botApprover,
      files: ['a.go'],
      user: 'prow-bot',
      labels: ['approved'],
      reviews: [mirrored({ id: 5, user: { login: 'Prow-Bot', type: 'User' } })],
    })

    await approveOnPullRequest(prEvent('synchronize'))

    expect(writes.calls).toEqual(['unlabel', 'notifier', 'dismiss'])
    expect(writes.dismissed[0].body).toEqual({ message: 'approved removed: no approver covers a.go' })
  })

  it('nor is any other review by the token\'s user, marker or not', async () => {
    const writes = serve({
      owners: botApprover,
      files: ['a.go'],
      user: 'prow-bot',
      reviews: [{ state: 'APPROVED', user: { login: 'prow-bot', type: 'User' }, commit_id: head }],
    })

    await approveOnPullRequest(prEvent('opened'))

    expect(writes.calls).toEqual(['notifier'])
  })

  it('a failing GET /user fails the evaluation before anything is written', async () => {
    const writes = serve({ user: 500, comments: [approveBy('bob'), approveBy('carol')] })

    await expect(approveOnPullRequest(prEvent('opened'))).rejects.toThrow('could not identify the token for approve.github_review')
    expect(writes.calls).toEqual([])
  })
})

describe('approve.github_review: no loops', () => {
  it('pull_request_review for the mirrored review evaluates nothing (submitted and dismissed)', async () => {
    const observeTree = new utils.ObserveRequest()
    server.use(utils.defaultBranchTree(['OWNERS'], observeTree))

    for (const action of ['submitted', 'dismissed']) {
      await approveOnReview(reviewEvent(action, { id: 42, body: `Approved via /approve by bob (OWNERS).\n${reviewMarker}` }))
      expect(debug).toHaveBeenCalledWith('approve: review 42 is the approval review this action mirrors; nothing to evaluate')
    }
    await expect(observeTree.notCalled()).resolves.toBe('not called')
  })

  it('handlePullReqReview on the mirrored review: approve writes nothing, tide still evaluates', async () => {
    const writes = serve({ labels: ['approved'], comments: [approveBy('bob'), approveBy('carol')], reviews: [mirrored()] })

    await handlePullReqReview(reviewEvent('submitted', { body: mirrored().body, user: bot }))

    expect(writes.calls).toEqual([])
    expect(setFailed).not.toHaveBeenCalled()
  })

  it('a second run on the same event submits no second review', async () => {
    const first = serve({ comments: [approveBy('bob'), approveBy('carol')] })
    await approveOnPullRequest(prEvent('reopened'))
    expect(first.created).toHaveLength(1)

    server.resetHandlers()
    utils.setupActionsEnv()
    const second = serve({ labels: ['approved'], comments: [approveBy('bob'), approveBy('carol')], reviews: [mirrored()] })
    await approveOnPullRequest(prEvent('reopened'))
    expect(second.created).toEqual([])
  })
})

describe('approve.github_review: order within one run', () => {
  it('label, review, then the merge evaluation of the same run', async () => {
    utils.setupJobsEnv('')
    const writes = serve({ owners: { OWNERS: 'approvers:\n- alice\n' }, files: ['src/a.go'], author: 'alice', labels: ['lgtm'] })
    server.use(
      utils.lgtmStatus(head),
      http.put(`${repo}/pulls/1/merge`, () => {
        writes.calls.push('merge')
        return Response.json({ merged: true })
      }),
    )
    let pulls = 0
    server.use(http.get(`${repo}/pulls/1`, () => {
      pulls++
      return Response.json({ ...pullBody, user: { login: 'alice' }, labels: (pulls === 1 ? ['lgtm'] : ['lgtm', 'approved']).map(name => ({ name })) })
    }))

    await handlePullReq(prEvent('reopened'))

    expect(writes.calls).toEqual(['label', 'notifier', 'review', 'merge'])
    expect(setFailed).not.toHaveBeenCalled()
  })

  it('a failed review is reported at the end of the run; tide still evaluates', async () => {
    utils.setupJobsEnv('')
    const writes = serve({ comments: [approveBy('bob'), approveBy('carol')], createReview: { status: 500, body: { message: 'Server Error' } } })
    let pulls = 0
    server.use(http.get(`${repo}/pulls/1`, () => {
      pulls++
      return Response.json({ ...pullBody, user: { login: 'some-author' }, labels: [] })
    }))

    await handlePullReq(prEvent('reopened'))

    expect(writes.calls).toEqual(['label', 'notifier', 'review'])
    // the owners read, then tide's own read
    expect(pulls).toBe(2)
    expect(core.info).toHaveBeenCalledWith('skipping pr #1: missing lgtm')
    expect(setFailed).toHaveBeenCalledWith(expect.stringContaining('could not submit the approval review: HttpError: Server Error'))
  })
})

describe('tokenIdentity', () => {
  it('a 404 on GET /user is an installation token too, and the answer is memoized per client', async () => {
    const getAuthenticated = vi.fn().mockRejectedValue(Object.assign(new Error('Not Found'), { status: 404 }))
    const octokit = { users: { getAuthenticated } } as unknown as Parameters<typeof tokenIdentity>[0]

    await expect(tokenIdentity(octokit)).resolves.toEqual({})
    await expect(tokenIdentity(octokit)).resolves.toEqual({})
    expect(getAuthenticated).toHaveBeenCalledTimes(1)
  })

  it('a rejection without a status fails', async () => {
    const octokit = { users: { getAuthenticated: vi.fn().mockRejectedValue('boom') } } as unknown as Parameters<typeof tokenIdentity>[0]

    await expect(tokenIdentity(octokit)).rejects.toThrow('could not identify the token for approve.github_review: boom')
  })
})

describe('syncApprovalReview', () => {
  it('a non-Error rejection of the review is an error', async () => {
    const octokit = { pulls: { createReview: vi.fn().mockRejectedValue('boom') } } as unknown as Parameters<typeof syncApprovalReview>[0]
    const input = {
      owners: { number: 1, open: true, headSha: head, author: 'someone' } as PullRequestOwners,
      state: { approved: true, approvers: new Set(['bob']) } as ApprovalState,
      reviews: [],
      identity: {},
      reason: () => '',
    }

    await expect(syncApprovalReview(octokit, prEvent('opened'), input)).rejects.toThrow('could not submit the approval review: boom')
  })
})

describe('withdrawalReason', () => {
  const settings: ApproveSettings = { require_self_approval: false, ignore_review_state: false, lgtm_acts_as_approve: false, github_review: true }
  const owners = (files: string[]) => ({ number: 1, files } as PullRequestOwners)
  const state = (uncoveredFiles: string[]) => ({ uncoveredFiles } as ApprovalState)
  const event = (user: string, kind: ApprovalEvent['kind'], at: number): ApprovalEvent => ({ user, kind, at: new Date(at) })

  it('a pull request without changed files', () => {
    expect(withdrawalReason(owners([]), state([]), [], settings)).toBe('the pull request changes no files')
  })

  it('lists five files at most', () => {
    const files = ['a', 'b', 'c', 'd', 'e', 'f', 'g']
    expect(withdrawalReason(owners(files), state(files), [], settings)).toBe('no approver covers a, b, c, d, e and 2 more')
  })

  it('names who withdrew last, and /lgtm cancel only when lgtm acts as approve', () => {
    const events = [
      event('Bob', 'approve', 1),
      event('bob', 'cancel', 2),
      event('carol', 'lgtm-cancel', 3),
      event('dave', 'cancel', 4),
      event('dave', 'approve', 5),
    ]
    expect(withdrawalReason(owners(['x']), state(['x']), events, settings)).toBe('no approver covers x; withdrawn by bob (/approve cancel)')
    expect(withdrawalReason(owners(['x']), state(['x']), events, { ...settings, lgtm_acts_as_approve: true }))
      .toBe('no approver covers x; withdrawn by bob (/approve cancel), carol (/lgtm cancel)')
  })
})

describe('isOwnReview', () => {
  const body = `x\n${reviewMarker}`

  it('an installation token owns marked reviews by bots', () => {
    expect(isOwnReview({ id: 1, state: 'APPROVED', body, user: bot }, {})).toBe(true)
    expect(isOwnReview({ id: 1, state: 'APPROVED', body, user: { login: 'other-app[bot]', type: 'Bot' } }, {})).toBe(true)
    expect(isOwnReview({ id: 1, state: 'APPROVED', body, user: { login: 'bob', type: 'User' } }, {})).toBe(false)
    expect(isOwnReview({ id: 1, state: 'APPROVED', body: 'no marker', user: bot }, {})).toBe(false)
    expect(isOwnReview({ id: 1, state: 'APPROVED', user: bot }, {})).toBe(false)
  })

  it('a user token owns marked reviews by its own login only', () => {
    expect(isOwnReview({ id: 1, state: 'APPROVED', body, user: { login: 'Prow-Bot' } }, { login: 'prow-bot' })).toBe(true)
    expect(isOwnReview({ id: 1, state: 'APPROVED', body, user: bot }, { login: 'prow-bot' })).toBe(false)
    expect(isOwnReview({ id: 1, state: 'APPROVED', body, user: null }, { login: 'prow-bot' })).toBe(false)
  })
})
