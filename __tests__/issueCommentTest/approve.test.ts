import { Buffer } from 'node:buffer'
import * as core from '@actions/core'
import { http } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { handleIssueComment } from '../../src/issueComment/handleIssueComment'
import { notifierMarker } from '../../src/plugins/approve'

import issueCommentEventAssign from '../fixtures/issues/assign/issueCommentEventAssign.json'
import labelFileContents from '../fixtures/labels/labelFileContentsResp.json'

import pullReqListReviews from '../fixtures/pullReq/pullReqListReviews.json'
import * as utils from '../testUtils'
import { prCommentEvent, prHandlers, repo } from '../utils/ownersFixtures'

const server = setupServer()
beforeAll(() =>
  server.listen({
    onUnhandledRequest: 'error',
  }),
)
// a label command is followed by the needs-* re-check and the merge gate: no prow.yaml in any tier, no OWNERS files
beforeEach(() => server.use(...utils.noOrgOrRepoConfigExcept(), utils.defaultBranchTree()))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

describe('/approve', () => {
  beforeEach(() => {
    utils.setupActionsEnv('/approve')
  })

  it('fails if commenter is not an approver in OWNERS', async () => {
    const owners = Buffer.from(
      `
reviewers:
- Codertocat
    `,
    ).toString('base64')

    const contentResponse = {
      type: 'file',
      encoding: 'base64',
      size: 4096,
      name: 'OWNERS',
      path: 'OWNERS',
      content: owners,
    }

    server.use(
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/contents/OWNERS`,
        utils.mockResponse(200, contentResponse),
      ),
    )
    const wantErr = `Codertocat is not included in the approvers role in the OWNERS file`

    // Mock the reply that the user is not authorized
    const observeReq = new utils.ObserveRequest()
    server.use(
      http.post(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1/comments`,
        utils.mockResponse(200, null, observeReq),
      ),
    )

    issueCommentEventAssign.comment.body = '/approve'
    const commentContext = new utils.MockContext(issueCommentEventAssign)

    await handleIssueComment(commentContext)
    await observeReq.called()
    expect(await observeReq.body().then(body => body.body)).toContain(wantErr)
  })

  it('fails if commenter is not an org member or collaborator', async () => {
    const wantErr = `Codertocat is not a org member or collaborator`

    // Mock the reply that the user is not authorized
    const observeReq = new utils.ObserveRequest()
    server.use(
      http.post(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1/comments`,
        utils.mockResponse(200, null, observeReq),
      ),
    )

    server.use(
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/contents/OWNERS`,
        utils.mockResponse(404),
      ),
      http.get(
        `${utils.api}/orgs/Codertocat/members/Codertocat`,
        utils.mockResponse(404),
      ),
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/collaborators/Codertocat`,
        utils.mockResponse(404),
      ),
    )

    issueCommentEventAssign.comment.body = '/approve'
    const commentContext = new utils.MockContext(issueCommentEventAssign)

    await handleIssueComment(commentContext)
    await observeReq.called()
    expect(await observeReq.body().then(body => body.body)).toContain(wantErr)
  })

  it('approves if commenter is an approver in OWNERS', async () => {
    const owners = Buffer.from(
      `
    approvers:
    - Codertocat
        `,
    ).toString('base64')

    const contentResponse = {
      type: 'file',
      encoding: 'base64',
      size: 4096,
      name: 'OWNERS',
      path: 'OWNERS',
      content: owners,
    }
    server.use(
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/contents/OWNERS`,
        utils.mockResponse(200, contentResponse),
      ),
    )

    const observeReq = new utils.ObserveRequest()
    server.use(
      http.post(
        `${utils.api}/repos/Codertocat/Hello-World/pulls/1/reviews`,
        utils.mockResponse(200, null, observeReq),
      ),
    )

    issueCommentEventAssign.comment.body = '/approve'
    const commentContext = new utils.MockContext(issueCommentEventAssign)

    await handleIssueComment(commentContext)
    await observeReq.called()
    expect(await observeReq.body()).toMatchObject({
      event: 'APPROVE',
    })
  })

  it('approves if commenter is an org member', async () => {
    server.use(
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/contents/OWNERS`,
        utils.mockResponse(404),
      ),
      http.get(
        `${utils.api}/orgs/Codertocat/members/Codertocat`,
        utils.mockResponse(204),
      ),
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/collaborators/Codertocat`,
        utils.mockResponse(404),
      ),
    )

    const observeReq = new utils.ObserveRequest()
    server.use(
      http.post(
        `${utils.api}/repos/Codertocat/Hello-World/pulls/1/reviews`,
        utils.mockResponse(200, null, observeReq),
      ),
    )

    issueCommentEventAssign.comment.body = '/approve'
    const commentContext = new utils.MockContext(issueCommentEventAssign)

    await handleIssueComment(commentContext)
    await observeReq.called()
    expect(await observeReq.body()).toMatchObject({
      event: 'APPROVE',
    })
  })

  it('submits a bot review on a pull request whose base branch has no OWNERS files (legacy path)', async () => {
    const commentContext = new utils.MockContext(prCommentEvent('/approve', 'bob'))

    const observeReq = new utils.ObserveRequest()
    const observeLabels = new utils.ObserveRequest()
    server.use(
      http.post(`${repo}/pulls/1/reviews`, utils.mockResponse(200, null, observeReq)),
      http.post(`${repo}/issues/1/labels`, utils.mockResponse(200, null, observeLabels)),
      ...prHandlers({}, ['sdk/x.go']),
      http.get(`${utils.api}/orgs/Codertocat/members/bob`, utils.mockResponse(204)),
      http.get(`${repo}/collaborators/bob`, utils.mockResponse(404)),
    )

    const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})
    await handleIssueComment(commentContext)
    await observeReq.called()
    expect(await observeReq.body()).toMatchObject({ event: 'APPROVE' })
    await expect(observeLabels.notCalled()).resolves.toBe('not called')
    expect(setFailed).not.toHaveBeenCalled()
  })

  it('removes approval with the /approve cancel command if approver in OWNERS file', async () => {
    const owners = Buffer.from(
      `
    approvers:
    - some-user
    `,
    ).toString('base64')

    const contentResponse = {
      type: 'file',
      encoding: 'base64',
      size: 4096,
      name: 'OWNERS',
      path: 'OWNERS',
      content: owners,
    }
    server.use(
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/contents/OWNERS`,
        utils.mockResponse(200, contentResponse),
      ),
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/pulls/1/reviews`,
        utils.mockResponse(200, pullReqListReviews),
      ),
    )

    const observeReq = new utils.ObserveRequest()
    server.use(
      http.put(
        `${utils.api}/repos/Codertocat/Hello-World/pulls/1/reviews/80/dismissals`,
        utils.mockResponse(200, null, observeReq),
      ),
    )

    issueCommentEventAssign.comment.body = '/approve cancel'
    issueCommentEventAssign.comment.user.login = 'some-user'
    const commentContext = new utils.MockContext(issueCommentEventAssign)

    await handleIssueComment(commentContext)
    await observeReq.called()
    expect(await observeReq.body()).toMatchObject({
      message: `Canceled through prow-github-actions by @some-user`,
    })
  })

  it('fails /approve cancel when the bot has no approved review', async () => {
    const reviews = structuredClone(pullReqListReviews)
    reviews[0].state = 'COMMENTED'

    server.use(
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/contents/OWNERS`,
        utils.mockResponse(404),
      ),
      http.get(
        `${utils.api}/orgs/Codertocat/members/some-user`,
        utils.mockResponse(404),
      ),
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/collaborators/some-user`,
        utils.mockResponse(204),
      ),
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/pulls/1/reviews`,
        utils.mockResponse(200, reviews),
      ),
    )

    const observeReq = new utils.ObserveRequest()
    server.use(
      http.put(
        `${utils.api}/repos/Codertocat/Hello-World/pulls/1/reviews/80/dismissals`,
        utils.mockResponse(200, null, observeReq),
      ),
    )

    issueCommentEventAssign.comment.body = '/approve cancel'
    issueCommentEventAssign.comment.user.login = 'some-user'
    const commentContext = new utils.MockContext(issueCommentEventAssign)

    const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})
    await handleIssueComment(commentContext)
    await expect(observeReq.notCalled()).resolves.toBe('not called')
    expect(setFailed).toHaveBeenCalledWith(
      expect.stringContaining('no latest review found to cancel'),
    )
  })

  it('removes approval with /remove-approve if commenter is collaborator', async () => {
    server.use(
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/contents/OWNERS`,
        utils.mockResponse(404),
      ),
      http.get(
        `${utils.api}/orgs/Codertocat/members/some-user`,
        utils.mockResponse(404),
      ),
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/collaborators/some-user`,
        utils.mockResponse(204),
      ),
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/pulls/1/reviews`,
        utils.mockResponse(200, pullReqListReviews),
      ),
    )

    const observeDismiss = new utils.ObserveRequest()
    const observeCreate = new utils.ObserveRequest()
    server.use(
      http.put(
        `${utils.api}/repos/Codertocat/Hello-World/pulls/1/reviews/80/dismissals`,
        utils.mockResponse(200, null, observeDismiss),
      ),
      http.post(
        `${utils.api}/repos/Codertocat/Hello-World/pulls/1/reviews`,
        utils.mockResponse(200, null, observeCreate),
      ),
    )

    issueCommentEventAssign.comment.body = '/remove-approve'
    issueCommentEventAssign.comment.user.login = 'some-user'
    const commentContext = new utils.MockContext(issueCommentEventAssign)

    const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})
    await handleIssueComment(commentContext)
    await observeDismiss.called()
    expect(await observeDismiss.body()).toMatchObject({
      message: `Canceled through prow-github-actions by @some-user`,
    })
    await expect(observeCreate.notCalled()).resolves.toBe('not called')
    expect(setFailed).not.toHaveBeenCalled()
  })

  it('fails /remove-approve for a commenter who is not an approver', async () => {
    const wantErr = `Codertocat is not a org member or collaborator`

    const observeComment = new utils.ObserveRequest()
    const observeDismiss = new utils.ObserveRequest()
    server.use(
      http.post(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1/comments`,
        utils.mockResponse(200, null, observeComment),
      ),
      http.put(
        `${utils.api}/repos/Codertocat/Hello-World/pulls/1/reviews/80/dismissals`,
        utils.mockResponse(200, null, observeDismiss),
      ),
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/contents/OWNERS`,
        utils.mockResponse(404),
      ),
      http.get(
        `${utils.api}/orgs/Codertocat/members/Codertocat`,
        utils.mockResponse(404),
      ),
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/collaborators/Codertocat`,
        utils.mockResponse(404),
      ),
    )

    issueCommentEventAssign.comment.body = '/remove-approve'
    issueCommentEventAssign.comment.user.login = 'Codertocat'
    const commentContext = new utils.MockContext(issueCommentEventAssign)

    const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})
    await handleIssueComment(commentContext)
    await observeComment.called()
    expect(await observeComment.body().then(body => body.body)).toContain(wantErr)
    await expect(observeDismiss.notCalled()).resolves.toBe('not called')
    expect(setFailed).toHaveBeenCalledWith(expect.stringContaining(wantErr))
  })

  it('approves with /approve no-issue if commenter is an org member', async () => {
    server.use(
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/contents/OWNERS`,
        utils.mockResponse(404),
      ),
      http.get(
        `${utils.api}/orgs/Codertocat/members/Codertocat`,
        utils.mockResponse(204),
      ),
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/collaborators/Codertocat`,
        utils.mockResponse(404),
      ),
    )

    const observeReq = new utils.ObserveRequest()
    server.use(
      http.post(
        `${utils.api}/repos/Codertocat/Hello-World/pulls/1/reviews`,
        utils.mockResponse(200, null, observeReq),
      ),
    )

    issueCommentEventAssign.comment.body = '/approve no-issue'
    issueCommentEventAssign.comment.user.login = 'Codertocat'
    const commentContext = new utils.MockContext(issueCommentEventAssign)

    await handleIssueComment(commentContext)
    await observeReq.called()
    expect(await observeReq.body()).toMatchObject({
      event: 'APPROVE',
    })
  })

  it('approves with /approve no-issue if commenter is an approver in OWNERS', async () => {
    const owners = Buffer.from(
      `
    approvers:
    - Codertocat
        `,
    ).toString('base64')

    const contentResponse = {
      type: 'file',
      encoding: 'base64',
      size: 4096,
      name: 'OWNERS',
      path: 'OWNERS',
      content: owners,
    }
    const observeMembers = new utils.ObserveRequest()
    server.use(
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/contents/OWNERS`,
        utils.mockResponse(200, contentResponse),
      ),
      http.get(
        `${utils.api}/orgs/Codertocat/members/Codertocat`,
        utils.mockResponse(204, null, observeMembers),
      ),
    )

    const observeReq = new utils.ObserveRequest()
    server.use(
      http.post(
        `${utils.api}/repos/Codertocat/Hello-World/pulls/1/reviews`,
        utils.mockResponse(200, null, observeReq),
      ),
    )

    issueCommentEventAssign.comment.body = '/approve no-issue'
    issueCommentEventAssign.comment.user.login = 'Codertocat'
    const commentContext = new utils.MockContext(issueCommentEventAssign)

    const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})
    await handleIssueComment(commentContext)
    await observeReq.called()
    expect(await observeReq.body()).toMatchObject({
      event: 'APPROVE',
    })
    await expect(observeMembers.notCalled()).resolves.toBe('not called')
    expect(setFailed).not.toHaveBeenCalled()
  })

  it('fails /remove-approve when the bot has no approved review', async () => {
    const reviews = structuredClone(pullReqListReviews)
    reviews[0].state = 'COMMENTED'

    server.use(
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/contents/OWNERS`,
        utils.mockResponse(404),
      ),
      http.get(
        `${utils.api}/orgs/Codertocat/members/some-user`,
        utils.mockResponse(404),
      ),
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/collaborators/some-user`,
        utils.mockResponse(204),
      ),
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/pulls/1/reviews`,
        utils.mockResponse(200, reviews),
      ),
    )

    const observeDismiss = new utils.ObserveRequest()
    const observeCreate = new utils.ObserveRequest()
    server.use(
      http.put(
        `${utils.api}/repos/Codertocat/Hello-World/pulls/1/reviews/80/dismissals`,
        utils.mockResponse(200, null, observeDismiss),
      ),
      http.post(
        `${utils.api}/repos/Codertocat/Hello-World/pulls/1/reviews`,
        utils.mockResponse(200, null, observeCreate),
      ),
    )

    issueCommentEventAssign.comment.body = '/remove-approve'
    issueCommentEventAssign.comment.user.login = 'some-user'
    const commentContext = new utils.MockContext(issueCommentEventAssign)

    const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})
    await handleIssueComment(commentContext)
    await expect(observeDismiss.notCalled()).resolves.toBe('not called')
    await expect(observeCreate.notCalled()).resolves.toBe('not called')
    expect(setFailed).toHaveBeenCalledWith(
      expect.stringContaining('no latest review found to cancel'),
    )
  })

  it.each([
    ['/approve\n/approve cancel'],
    ['/approve cancel\n/approve'],
  ])('cancel wins when a comment carries both /approve and /approve cancel: %j', async (body) => {
    server.use(
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/contents/OWNERS`,
        utils.mockResponse(404),
      ),
      http.get(
        `${utils.api}/orgs/Codertocat/members/some-user`,
        utils.mockResponse(404),
      ),
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/collaborators/some-user`,
        utils.mockResponse(204),
      ),
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/pulls/1/reviews`,
        utils.mockResponse(200, pullReqListReviews),
      ),
    )

    const observeDismiss = new utils.ObserveRequest()
    const observeCreate = new utils.ObserveRequest()
    server.use(
      http.put(
        `${utils.api}/repos/Codertocat/Hello-World/pulls/1/reviews/80/dismissals`,
        utils.mockResponse(200, null, observeDismiss),
      ),
      http.post(
        `${utils.api}/repos/Codertocat/Hello-World/pulls/1/reviews`,
        utils.mockResponse(200, null, observeCreate),
      ),
    )

    issueCommentEventAssign.comment.body = body
    issueCommentEventAssign.comment.user.login = 'some-user'
    const commentContext = new utils.MockContext(issueCommentEventAssign)

    const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})
    await handleIssueComment(commentContext)
    await expect(observeDismiss.called()).resolves.toBe('called')
    await expect(observeCreate.notCalled()).resolves.toBe('not called')
    expect(setFailed).not.toHaveBeenCalled()
  })

  describe('on a pull request whose base branch has OWNERS files', () => {
    const twoDirs = {
      'OWNERS': 'approvers:\n- alice\n',
      'sdk/OWNERS': 'approvers:\n- bob\n',
      'olm/OWNERS': 'options:\n  no_parent_owners: true\napprovers:\n- carol\n',
    }
    const bot = { login: 'github-actions[bot]', type: 'Bot' }

    interface Scenario {
      owners?: Record<string, string>
      files?: string[]
      labels?: string[]
      comments?: { id?: number, body: string, user: { login: string, type?: string } }[]
      reviews?: unknown[]
      repoLabels?: string[]
      prowYaml?: string
    }

    function serve(scenario: Scenario = {}) {
      const { owners = twoDirs, files = ['sdk/x.go', 'olm/y.go'], labels = [], comments = [], reviews = [], repoLabels = ['approved'], prowYaml } = scenario
      const writes = {
        addLabels: new utils.ObserveRequest(),
        removeLabel: new utils.ObserveRequest(),
        postComment: new utils.ObserveRequest(),
        patchComment: new utils.ObserveRequest(),
        listComments: new utils.ObserveRequest(),
        createReview: new utils.ObserveRequest(),
        dismissReview: new utils.ObserveRequest(),
      }
      const configFile = structuredClone(labelFileContents)
      configFile.content = Buffer.from(prowYaml ?? '').toString('base64')
      server.use(
        ...utils.noOrgOrRepoConfigExcept(...(prowYaml === undefined ? [] : ['.github/prow.yaml'])),
        ...(prowYaml === undefined ? [] : [http.get(utils.contentsUrl('.github/prow.yaml'), utils.mockResponse(200, configFile))]),
        ...prHandlers(owners, files, { user: { login: 'some-author' }, labels: labels.map(name => ({ name })) }),
        utils.repoHasLabels(repoLabels),
        http.get(`${repo}/issues/1/comments`, utils.mockResponse(200, comments.map((c, i) => ({ id: c.id ?? 100 + i, created_at: new Date(Date.UTC(2024, 0, 1, 0, 0, i + 1)).toISOString(), ...c })), writes.listComments)),
        http.get(`${repo}/pulls/1/reviews`, utils.mockResponse(200, reviews)),
        http.post(`${repo}/issues/1/labels`, utils.mockResponse(200, [], writes.addLabels)),
        http.delete(`${repo}/issues/1/labels/approved`, utils.mockResponse(200, [], writes.removeLabel)),
        http.post(`${repo}/issues/1/comments`, utils.mockResponse(201, {}, writes.postComment)),
        http.patch(`${repo}/issues/comments/900`, utils.mockResponse(200, {}, writes.patchComment)),
        http.post(`${repo}/pulls/1/reviews`, utils.mockResponse(200, {}, writes.createReview)),
        http.put(`${repo}/pulls/1/reviews/80/dismissals`, utils.mockResponse(200, {}, writes.dismissReview)),
      )
      return writes
    }

    const notifier = (body: string) => ({ id: 900, body: `${body}\n${notifierMarker}`, user: bot })
    const commentBody = async (observe: utils.ObserveRequest) => (await observe.body()).body as string

    let setFailed: ReturnType<typeof vi.spyOn>
    beforeEach(() => {
      setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})
    })

    it('/approve by an approver covering every file adds approved and posts the notifier; no bot review', async () => {
      const writes = serve({ owners: { OWNERS: 'approvers:\n- alice\n' }, files: ['src/a.go'], comments: [{ body: '/approve', user: { login: 'alice' } }] })

      await handleIssueComment(new utils.MockContext(prCommentEvent('/approve', 'alice')))

      await expect(writes.addLabels.called()).resolves.toBe('called')
      expect(await writes.addLabels.body()).toEqual({ labels: ['approved'] })
      await expect(writes.postComment.called()).resolves.toBe('called')
      const body = await commentBody(writes.postComment)
      expect(body).toContain('[APPROVALNOTIFIER] This PR is **APPROVED**')
      expect(body).toContain('approved by: *alice*')
      expect(body.endsWith(notifierMarker)).toBe(true)
      await expect(writes.createReview.notCalled()).resolves.toBe('not called')
      expect(setFailed).not.toHaveBeenCalled()
    })

    it('a second /approve edits the notifier in place and does not re-add the label', async () => {
      const writes = serve({
        owners: { OWNERS: 'approvers:\n- alice\n- zed\n' },
        files: ['src/a.go'],
        labels: ['approved'],
        comments: [notifier('stale'), { body: '/approve', user: { login: 'alice' } }, { body: '/approve', user: { login: 'zed' } }],
      })

      await handleIssueComment(new utils.MockContext(prCommentEvent('/approve', 'zed')))

      await expect(writes.patchComment.called()).resolves.toBe('called')
      expect(await commentBody(writes.patchComment)).toContain('approved by: *alice*, *zed*')
      await expect(writes.postComment.notCalled()).resolves.toBe('not called')
      await expect(writes.addLabels.notCalled()).resolves.toBe('not called')
      expect(setFailed).not.toHaveBeenCalled()
    })

    it.each(['/approve cancel', '/remove-approve'])('%s removes approved and rewrites the notifier; no review is dismissed', async (command) => {
      const writes = serve({
        owners: { OWNERS: 'approvers:\n- alice\n' },
        files: ['src/a.go'],
        labels: ['approved'],
        comments: [notifier('stale'), { body: '/approve', user: { login: 'alice' } }, { body: command, user: { login: 'alice' } }],
        reviews: pullReqListReviews,
      })

      await handleIssueComment(new utils.MockContext(prCommentEvent(command, 'alice')))

      await expect(writes.removeLabel.called()).resolves.toBe('called')
      await expect(writes.patchComment.called()).resolves.toBe('called')
      const body = await commentBody(writes.patchComment)
      expect(body).toContain('This PR is **NOT APPROVED**')
      expect(body).toContain('please assign **alice**')
      await expect(writes.dismissReview.notCalled()).resolves.toBe('not called')
      await expect(writes.createReview.notCalled()).resolves.toBe('not called')
      expect(setFailed).not.toHaveBeenCalled()
    })

    it('/approve by an approver of one of two directories: no label, the notifier suggests the other', async () => {
      const writes = serve({ comments: [{ body: '/approve', user: { login: 'bob' } }] })

      await handleIssueComment(new utils.MockContext(prCommentEvent('/approve', 'bob')))

      await expect(writes.postComment.called()).resolves.toBe('called')
      const body = await commentBody(writes.postComment)
      expect(body).toContain('This PR is **NOT APPROVED**')
      expect(body).toContain('approved by: *bob*')
      expect(body).toContain('please assign **carol**')
      expect(body).toContain('- **[olm/OWNERS](https://github.com/Codertocat/Hello-World/blob/basesha/olm/OWNERS)**')
      expect(body).toContain('- ~~[sdk/OWNERS](https://github.com/Codertocat/Hello-World/blob/basesha/sdk/OWNERS)~~ [bob]')
      await expect(writes.addLabels.notCalled()).resolves.toBe('not called')
      await expect(writes.createReview.notCalled()).resolves.toBe('not called')
      expect(setFailed).not.toHaveBeenCalled()
    })

    it('/approve no-issue behaves like /approve', async () => {
      const writes = serve({ owners: { OWNERS: 'approvers:\n- alice\n' }, files: ['src/a.go'], comments: [{ body: '/approve no-issue', user: { login: 'alice' } }] })

      await handleIssueComment(new utils.MockContext(prCommentEvent('/approve no-issue', 'alice')))

      await expect(writes.addLabels.called()).resolves.toBe('called')
      expect(setFailed).not.toHaveBeenCalled()
    })

    it('refuses a commenter who approves no changed file with a comment and fails, without evaluating', async () => {
      const writes = serve()
      const wantErr = 'rita is not an approver for any changed file'

      await handleIssueComment(new utils.MockContext(prCommentEvent('/approve', 'rita')))

      await expect(writes.postComment.called()).resolves.toBe('called')
      expect(await commentBody(writes.postComment)).toBe(`Cannot approve the pull request: Error: ${wantErr}`)
      await expect(writes.listComments.notCalled()).resolves.toBe('not called')
      await expect(writes.createReview.notCalled()).resolves.toBe('not called')
      expect(setFailed).toHaveBeenCalledWith(expect.stringContaining(wantErr))
    })

    it('require_self_approval: the author cannot /approve their own pull request', async () => {
      const writes = serve({
        owners: { OWNERS: 'approvers:\n- some-author\n' },
        files: ['src/a.go'],
        prowYaml: 'approve:\n  require_self_approval: true\n',
        comments: [{ body: '/approve', user: { login: 'some-author' } }],
      })

      await handleIssueComment(new utils.MockContext(prCommentEvent('/approve', 'some-author')))

      await expect(writes.postComment.called()).resolves.toBe('called')
      expect(await commentBody(writes.postComment)).toContain('you cannot approve your own PR')
      await expect(writes.listComments.notCalled()).resolves.toBe('not called')
      await expect(writes.addLabels.notCalled()).resolves.toBe('not called')
      expect(setFailed).toHaveBeenCalledWith(expect.stringContaining('you cannot approve your own PR'))
    })

    it('fails when the repository lacks the approved label', async () => {
      const writes = serve({ owners: { OWNERS: 'approvers:\n- alice\n' }, files: ['src/a.go'], comments: [{ body: '/approve', user: { login: 'alice' } }], repoLabels: ['lgtm'] })

      await handleIssueComment(new utils.MockContext(prCommentEvent('/approve', 'alice')))

      await expect(writes.postComment.notCalled()).resolves.toBe('not called')
      expect(setFailed).toHaveBeenCalledWith(expect.stringContaining('the label(s) approved cannot be applied because the repository doesn\'t have them'))
    })
  })

  it.each(['/approve cancel', '/Approve CANCEL'])('removes approval with %s if commenter is collaborator', async (body) => {
    server.use(
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/contents/OWNERS`,
        utils.mockResponse(404),
      ),
      http.get(
        `${utils.api}/orgs/Codertocat/members/some-user`,
        utils.mockResponse(404),
      ),
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/collaborators/some-user`,
        utils.mockResponse(204),
      ),
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/pulls/1/reviews`,
        utils.mockResponse(200, pullReqListReviews),
      ),
    )

    const observeReq = new utils.ObserveRequest()
    server.use(
      http.put(
        `${utils.api}/repos/Codertocat/Hello-World/pulls/1/reviews/80/dismissals`,
        utils.mockResponse(200, null, observeReq),
      ),
    )

    issueCommentEventAssign.comment.body = body
    issueCommentEventAssign.comment.user.login = 'some-user'
    const commentContext = new utils.MockContext(issueCommentEventAssign)

    await handleIssueComment(commentContext)
    await observeReq.called()
    expect(await observeReq.body()).toMatchObject({
      message: `Canceled through prow-github-actions by @some-user`,
    })
  })
})
