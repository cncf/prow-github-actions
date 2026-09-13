import { Buffer } from 'node:buffer'
import * as core from '@actions/core'
import { http } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { approveOnPullRequest, approveOnReview, notifierMarker } from '../../src/plugins/approve'
import { handlePullReq } from '../../src/pullReq/handlePullReq'
import { handlePullReqReview } from '../../src/pullReq/handlePullReqReview'
import labelFileContents from '../fixtures/labels/labelFileContentsResp.json'
import pullReqOpenedEvent from '../fixtures/pullReq/pullReqOpenedEvent.json'
import reviewSubmittedEvent from '../fixtures/pullReq/pullReqReviewSubmittedEvent.json'
import * as utils from '../testUtils'
import { prHandlers, repo } from '../utils/ownersFixtures'

const server = setupServer()
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

const twoDirs = {
  'OWNERS': 'approvers:\n- alice\n',
  'sdk/OWNERS': 'approvers:\n- bob\n',
  'olm/OWNERS': 'options:\n  no_parent_owners: true\napprovers:\n- carol\n',
}
const twoFiles = ['sdk/x.go', 'olm/y.go']

interface Actor { login: string, type?: string }
interface Comment { id?: number, body: string, user: Actor, created_at?: string }
interface ReviewFixture { id?: number, state: string, user: Actor, submitted_at?: string }

interface Scenario {
  owners?: Record<string, string>
  files?: string[]
  author?: string
  /** labels on the pull request */
  labels?: string[]
  comments?: Comment[]
  reviews?: ReviewFixture[]
  /** labels the repository defines */
  repoLabels?: string[]
  /** the default branch tree; defaults to the same OWNERS paths as `owners` */
  defaultBranch?: string[]
  prowYaml?: string
}

const bot: Actor = { login: 'github-actions[bot]', type: 'Bot' }

function stamp(index: number): string {
  return new Date(Date.UTC(2024, 0, 1, 0, 0, index)).toISOString()
}

function notifier(body: string, id = 900): Comment {
  return { id, body, user: bot, created_at: stamp(0) }
}

// the reads and writes of one approval evaluation, with an observer per write
function serve(scenario: Scenario = {}) {
  const {
    owners = twoDirs,
    files = twoFiles,
    author = 'some-author',
    labels = [],
    comments = [],
    reviews = [],
    repoLabels = ['approved', 'lgtm'],
    defaultBranch = Object.keys(owners),
    prowYaml,
  } = scenario

  const writes = {
    addLabels: new utils.ObserveRequest(),
    removeLabel: new utils.ObserveRequest(),
    postComment: new utils.ObserveRequest(),
    patchComment: new utils.ObserveRequest(),
    listReviews: new utils.ObserveRequest(),
    createReview: new utils.ObserveRequest(),
  }

  const configFile = structuredClone(labelFileContents)
  configFile.content = Buffer.from(prowYaml ?? '').toString('base64')

  server.use(
    ...utils.noOrgOrRepoConfigExcept(...(prowYaml === undefined ? [] : ['.github/prow.yaml'])),
    ...(prowYaml === undefined ? [] : [http.get(utils.contentsUrl('.github/prow.yaml'), utils.mockResponse(200, configFile))]),
    ...prHandlers(owners, files, { user: { login: author }, labels: labels.map(name => ({ name })) }),
    utils.defaultBranchTree(defaultBranch),
    utils.repoHasLabels(repoLabels),
    http.get(`${repo}/issues/1/comments`, utils.mockResponse(200, comments.map((c, i) => ({ id: c.id ?? 100 + i, created_at: stamp(i + 1), ...c })))),
    http.get(`${repo}/pulls/1/reviews`, utils.mockResponse(200, reviews.map((r, i) => ({ id: r.id ?? 200 + i, submitted_at: stamp(i + 1), ...r })), writes.listReviews)),
    http.post(`${repo}/issues/1/labels`, utils.mockResponse(200, [], writes.addLabels)),
    http.delete(`${repo}/issues/1/labels/approved`, utils.mockResponse(200, [], writes.removeLabel)),
    http.post(`${repo}/issues/1/comments`, utils.mockResponse(201, {}, writes.postComment)),
    http.patch(`${repo}/issues/comments/900`, utils.mockResponse(200, {}, writes.patchComment)),
    http.post(`${repo}/pulls/1/reviews`, utils.mockResponse(200, {}, writes.createReview)),
  )

  return writes
}

function prEvent(action: string, extra: Record<string, unknown> = {}) {
  return new utils.MockContext({ ...pullReqOpenedEvent, action, ...extra })
}

function reviewEvent(action = 'submitted') {
  return new utils.MockContext({ ...reviewSubmittedEvent, action })
}

async function commentBody(observe: utils.ObserveRequest): Promise<string> {
  return (await observe.body()).body
}

let setFailed: ReturnType<typeof vi.spyOn>
let debug: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  utils.setupActionsEnv()
  setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})
  debug = vi.spyOn(core, 'debug')
})

describe('approveOnPullRequest', () => {
  it('opened by an author who covers every changed file: adds approved and posts the APPROVED notifier', async () => {
    const writes = serve({ owners: { OWNERS: 'approvers:\n- alice\n' }, files: ['src/a.go'], author: 'Alice' })

    await approveOnPullRequest(prEvent('opened'))

    await expect(writes.addLabels.called()).resolves.toBe('called')
    expect(await writes.addLabels.body()).toEqual({ labels: ['approved'] })
    await expect(writes.postComment.called()).resolves.toBe('called')
    const body = await commentBody(writes.postComment)
    expect(body).toContain('[APPROVALNOTIFIER] This PR is **APPROVED**')
    expect(body).toContain('This pull-request has been approved by: *alice*')
    expect(body).toContain(`~~[OWNERS](https://github.com/Codertocat/Hello-World/blob/basesha/OWNERS)~~ [alice]`)
    expect(body.endsWith(notifierMarker)).toBe(true)
    await expect(writes.createReview.notCalled()).resolves.toBe('not called')
    await expect(writes.removeLabel.notCalled()).resolves.toBe('not called')
  })

  it('opened on a pull request spanning two directories: no label, the notifier suggests the missing approver', async () => {
    const writes = serve({ comments: [{ body: '/approve', user: { login: 'bob' } }] })

    await approveOnPullRequest(prEvent('opened'))

    await expect(writes.postComment.called()).resolves.toBe('called')
    const body = await commentBody(writes.postComment)
    expect(body).toContain('This PR is **NOT APPROVED**')
    expect(body).toContain('This pull-request has been approved by: *bob*')
    expect(body).toContain('please assign **carol**')
    expect(body).toContain('- **[olm/OWNERS](https://github.com/Codertocat/Hello-World/blob/basesha/olm/OWNERS)**')
    expect(body).toContain('- ~~[sdk/OWNERS](https://github.com/Codertocat/Hello-World/blob/basesha/sdk/OWNERS)~~ [bob]')
    await expect(writes.addLabels.notCalled()).resolves.toBe('not called')
    expect(setFailed).not.toHaveBeenCalled()
  })

  it('edits the notifier in place and leaves a correct label alone', async () => {
    const stale = notifier(`[APPROVALNOTIFIER] This PR is **NOT APPROVED**\n\nstale\n${notifierMarker}`)
    const writes = serve({
      labels: ['approved'],
      comments: [stale, { body: '/approve', user: { login: 'bob' } }, { body: '/approve', user: { login: 'carol' } }],
    })

    await approveOnPullRequest(prEvent('synchronize'))

    await expect(writes.patchComment.called()).resolves.toBe('called')
    expect(await commentBody(writes.patchComment)).toContain('This PR is **APPROVED**')
    await expect(writes.postComment.notCalled()).resolves.toBe('not called')
    await expect(writes.addLabels.notCalled()).resolves.toBe('not called')
    await expect(writes.removeLabel.notCalled()).resolves.toBe('not called')
  })

  it('writes nothing when the notifier and the label already match', async () => {
    const first = serve({ labels: ['approved'], comments: [{ body: '/approve', user: { login: 'bob' } }, { body: '/approve', user: { login: 'carol' } }] })
    await approveOnPullRequest(prEvent('synchronize'))
    await expect(first.postComment.called()).resolves.toBe('called')
    const body = await commentBody(first.postComment)
    server.resetHandlers()
    utils.setupActionsEnv()

    const second = serve({ labels: ['approved'], comments: [notifier(body), { body: '/approve', user: { login: 'bob' } }, { body: '/approve', user: { login: 'carol' } }] })
    await approveOnPullRequest(prEvent('synchronize'))

    await expect(second.patchComment.notCalled()).resolves.toBe('not called')
    await expect(second.postComment.notCalled()).resolves.toBe('not called')
    await expect(second.addLabels.notCalled()).resolves.toBe('not called')
    expect(debug).toHaveBeenCalledWith('approve: the notifier on #1 is up to date')
  })

  it('synchronize keeps the approval: nothing is removed on a push', async () => {
    const writes = serve({ labels: ['approved'], comments: [{ body: '/approve', user: { login: 'bob' } }, { body: '/approve', user: { login: 'carol' } }] })

    await approveOnPullRequest(prEvent('synchronize'))

    await expect(writes.removeLabel.notCalled()).resolves.toBe('not called')
    await expect(writes.postComment.called()).resolves.toBe('called')
    expect(await commentBody(writes.postComment)).toContain('This PR is **APPROVED**')
  })

  it('a human removing approved while the pull request is covered gets it re-added', async () => {
    const writes = serve({ comments: [{ body: '/approve', user: { login: 'bob' } }, { body: '/approve', user: { login: 'carol' } }] })

    await approveOnPullRequest(prEvent('unlabeled', { label: { name: 'Approved' } }))

    await expect(writes.addLabels.called()).resolves.toBe('called')
    expect(await writes.addLabels.body()).toEqual({ labels: ['approved'] })
  })

  it('a human adding approved to an uncovered pull request gets it removed', async () => {
    const writes = serve({ labels: ['approved'], comments: [{ body: '/approve', user: { login: 'bob' } }] })

    await approveOnPullRequest(prEvent('labeled', { label: { name: 'approved' } }))

    await expect(writes.removeLabel.called()).resolves.toBe('called')
    await expect(writes.addLabels.notCalled()).resolves.toBe('not called')
  })

  it('labeled with another label makes no api call at all', async () => {
    const observeTree = new utils.ObserveRequest()
    server.use(utils.defaultBranchTree(['OWNERS'], observeTree))

    await approveOnPullRequest(prEvent('labeled', { label: { name: 'kind/bug' } }))

    await expect(observeTree.notCalled()).resolves.toBe('not called')
    expect(debug).toHaveBeenCalledWith('approve: labeled kind/bug does not concern approval')
  })

  it.each(['closed', 'ready_for_review', 'edited', 'assigned'])('%s is skipped', async (action) => {
    const observeTree = new utils.ObserveRequest()
    server.use(utils.defaultBranchTree(['OWNERS'], observeTree))

    await approveOnPullRequest(prEvent(action))

    await expect(observeTree.notCalled()).resolves.toBe('not called')
    expect(debug).toHaveBeenCalledWith(`approve: skipping ${action} action`)
  })

  it('a repository without OWNERS files on its default branch only reads the tree', async () => {
    const observePull = new utils.ObserveRequest()
    server.use(utils.defaultBranchTree(['README.md']), http.get(`${repo}/pulls/1`, utils.mockResponse(500, null, observePull)))

    await approveOnPullRequest(prEvent('opened'))

    await expect(observePull.notCalled()).resolves.toBe('not called')
    expect(debug).toHaveBeenCalledWith('approve: the repository has no OWNERS files')
  })

  it('a base branch without OWNERS files is left alone even when the default branch has them', async () => {
    const writes = serve({ owners: {}, defaultBranch: ['OWNERS'] })

    await approveOnPullRequest(prEvent('opened'))

    await expect(writes.postComment.notCalled()).resolves.toBe('not called')
    expect(debug).toHaveBeenCalledWith('approve: the base of #1 has no OWNERS files, nothing to evaluate')
  })

  it('fails when the repository lacks the approved label', async () => {
    const writes = serve({ owners: { OWNERS: 'approvers:\n- alice\n' }, files: ['src/a.go'], author: 'alice', repoLabels: ['lgtm'] })

    await expect(approveOnPullRequest(prEvent('opened'))).rejects.toThrow(
      'the label(s) approved cannot be applied because the repository doesn\'t have them. Run the label-sync job or create them.',
    )
    await expect(writes.postComment.notCalled()).resolves.toBe('not called')
  })

  it('ignore_review_state: reviews are not even listed', async () => {
    const writes = serve({
      prowYaml: 'approve:\n  ignore_review_state: true\n',
      reviews: [{ state: 'APPROVED', user: { login: 'bob' } }, { state: 'APPROVED', user: { login: 'carol' } }],
    })

    await approveOnPullRequest(prEvent('opened'))

    await expect(writes.postComment.called()).resolves.toBe('called')
    expect(await commentBody(writes.postComment)).toContain('This PR is **NOT APPROVED**')
    await expect(writes.listReviews.notCalled()).resolves.toBe('not called')
    await expect(writes.addLabels.notCalled()).resolves.toBe('not called')
  })

  it('require_self_approval: the author no longer counts', async () => {
    const writes = serve({ owners: { OWNERS: 'approvers:\n- alice\n' }, files: ['src/a.go'], author: 'alice', prowYaml: 'approve:\n  require_self_approval: true\n' })

    await approveOnPullRequest(prEvent('opened'))

    await expect(writes.postComment.called()).resolves.toBe('called')
    expect(await commentBody(writes.postComment)).toContain('This PR is **NOT APPROVED**')
    await expect(writes.addLabels.notCalled()).resolves.toBe('not called')
  })

  it('lgtm_acts_as_approve: /lgtm comments count', async () => {
    const writes = serve({
      prowYaml: 'approve:\n  lgtm_acts_as_approve: true\n',
      comments: [{ body: '/lgtm', user: { login: 'bob' } }, { body: '/lgtm', user: { login: 'carol' } }],
    })

    await approveOnPullRequest(prEvent('opened'))

    await expect(writes.addLabels.called()).resolves.toBe('called')
  })

  it('throws when the payload has no pull request', async () => {
    await expect(approveOnPullRequest(new utils.MockContext({ action: 'opened' }))).rejects.toThrow('missing pull request')
  })

  it('runs through handlePullReq before tide, which then sees the approved label', async () => {
    utils.setupJobsEnv('')
    const writes = serve({ owners: { OWNERS: 'approvers:\n- alice\n' }, files: ['src/a.go'], author: 'alice', labels: ['lgtm'] })
    const merge = new utils.ObserveRequest()
    const order: string[] = []
    server.use(
      http.post(`${repo}/issues/1/labels`, async (info) => {
        order.push('label')
        return utils.mockResponse(200, [], writes.addLabels)(info)
      }),
      http.put(`${repo}/pulls/1/merge`, async (info) => {
        order.push('merge')
        return utils.mockResponse(200, { merged: true }, merge)(info)
      }),
    )
    // tide re-reads the pull request after approve labeled it
    let pulls = 0
    server.use(http.get(`${repo}/pulls/1`, () => {
      pulls++
      const labels = pulls === 1 ? ['lgtm'] : ['lgtm', 'approved']
      return new Response(JSON.stringify({
        number: 1,
        state: 'open',
        locked: false,
        draft: false,
        merged: false,
        mergeable: true,
        mergeable_state: 'clean',
        labels: labels.map(name => ({ name })),
        base: { sha: 'basesha' },
        head: { sha: 'headsha' },
        user: { login: 'alice' },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }))

    await handlePullReq(prEvent('reopened'))

    await expect(merge.called()).resolves.toBe('called')
    expect(order).toEqual(['label', 'merge'])
    expect(setFailed).not.toHaveBeenCalled()
  })
})

describe('approveOnReview', () => {
  it('an APPROVED review completing the coverage adds the label', async () => {
    const writes = serve({
      author: 'carol',
      comments: [notifier(`stale\n${notifierMarker}`)],
      reviews: [{ state: 'APPROVED', user: { login: 'Bob' } }],
    })

    await approveOnReview(reviewEvent('submitted'))

    await expect(writes.addLabels.called()).resolves.toBe('called')
    await expect(writes.patchComment.called()).resolves.toBe('called')
    const body = await commentBody(writes.patchComment)
    expect(body).toContain('This PR is **APPROVED**')
    expect(body).toContain('approved by: *bob*, *carol*')
  })

  it('a CHANGES_REQUESTED review after /approve removes the approver and the label', async () => {
    const writes = serve({
      author: 'carol',
      labels: ['approved'],
      comments: [notifier(`stale\n${notifierMarker}`), { body: '/approve', user: { login: 'bob' } }],
      reviews: [{ state: 'CHANGES_REQUESTED', user: { login: 'bob' }, submitted_at: stamp(50) }],
    })

    await approveOnReview(reviewEvent('submitted'))

    await expect(writes.removeLabel.called()).resolves.toBe('called')
    await expect(writes.patchComment.called()).resolves.toBe('called')
    const body = await commentBody(writes.patchComment)
    expect(body).toContain('This PR is **NOT APPROVED**')
    // alice (root) and bob both cover sdk/; the alphabetical tie-break suggests alice
    expect(body).toContain('please assign **alice**')
  })

  it('a bot review never counts', async () => {
    const writes = serve({ author: 'carol', reviews: [{ state: 'APPROVED', user: bot }] })

    await approveOnReview(reviewEvent('submitted'))

    await expect(writes.postComment.called()).resolves.toBe('called')
    expect(await commentBody(writes.postComment)).toContain('This PR is **NOT APPROVED**')
    await expect(writes.addLabels.notCalled()).resolves.toBe('not called')
  })

  it('dismissed re-evaluates, edited is skipped', async () => {
    const writes = serve({ author: 'carol', labels: ['approved'], reviews: [{ state: 'DISMISSED', user: { login: 'bob' } }] })

    await approveOnReview(reviewEvent('dismissed'))
    await expect(writes.removeLabel.called()).resolves.toBe('called')

    const observeTree = new utils.ObserveRequest()
    server.use(utils.defaultBranchTree(['OWNERS'], observeTree))
    await approveOnReview(reviewEvent('edited'))
    await expect(observeTree.notCalled()).resolves.toBe('not called')
    expect(debug).toHaveBeenCalledWith('approve: skipping edited review action')
  })

  it('runs through handlePullReqReview before tide', async () => {
    const writes = serve({ author: 'carol', labels: ['lgtm'], reviews: [{ state: 'APPROVED', user: { login: 'bob' } }] })
    const merge = new utils.ObserveRequest()
    server.use(http.put(`${repo}/pulls/1/merge`, utils.mockResponse(200, { merged: true }, merge)))
    let pulls = 0
    server.use(http.get(`${repo}/pulls/1`, () => {
      pulls++
      return new Response(JSON.stringify({
        number: 1,
        state: 'open',
        locked: false,
        draft: false,
        merged: false,
        mergeable: true,
        mergeable_state: 'clean',
        labels: (pulls === 1 ? ['lgtm'] : ['lgtm', 'approved']).map(name => ({ name })),
        base: { sha: 'basesha' },
        head: { sha: 'headsha' },
        user: { login: 'carol' },
      }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }))

    await handlePullReqReview(reviewEvent('submitted'))

    await expect(writes.addLabels.called()).resolves.toBe('called')
    await expect(merge.called()).resolves.toBe('called')
    expect(setFailed).not.toHaveBeenCalled()
  })
})
