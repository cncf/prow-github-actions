import { http } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import * as job from '../../src/cronJobs/labelSync'
import { handleIssueComment } from '../../src/issueComment/handleIssueComment'
import issueCommentEvent from '../fixtures/issues/issueCommentEvent.json'
import * as utils from '../testUtils'

vi.mock('../../src/cronJobs/labelSync', { spy: true })

const server = setupServer()
utils.failTestOnUnhandledRequests(server)
beforeAll(() => server.listen(utils.failOnUnhandledRequest))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

const repo = `${utils.api}/repos/Codertocat/Hello-World`

function commentContext() {
  const payload = structuredClone(issueCommentEvent)
  payload.comment.body = '/label-sync'
  const context = new utils.MockContext(payload)
  context.eventName = 'issue_comment'
  return context
}

describe('/label-sync', () => {
  beforeEach(() => utils.setupActionsEnv('/label-sync'))

  it('runs the label-sync job for a collaborator and reports the result in a comment', async () => {
    vi.mocked(job.labelSync).mockResolvedValue({ created: ['kind/bug', 'lgtm'], updated: ['approved'], unchanged: 7, failures: [] })
    const observeComment = new utils.ObserveRequest()
    server.use(
      http.get(`${repo}/collaborators/Codertocat`, utils.mockResponse(204)),
      http.post(`${repo}/issues/1/comments`, utils.mockResponse(201, {}, observeComment)),
    )

    await handleIssueComment(commentContext())

    await observeComment.called()
    expect(job.labelSync).toHaveBeenCalledTimes(1)
    expect((await observeComment.body()).body).toBe('label-sync: created 2, updated 1, unchanged 7.\nCreated: `kind/bug`, `lgtm`\nUpdated: `approved`')
  })

  it('reports a run that changed nothing in one line', async () => {
    vi.mocked(job.labelSync).mockResolvedValue({ created: [], updated: [], unchanged: 19, failures: [] })
    const observeComment = new utils.ObserveRequest()
    server.use(
      http.get(`${repo}/collaborators/Codertocat`, utils.mockResponse(204)),
      http.post(`${repo}/issues/1/comments`, utils.mockResponse(201, {}, observeComment)),
    )

    await handleIssueComment(commentContext())

    await observeComment.called()
    expect((await observeComment.body()).body).toBe('label-sync: created 0, updated 0, unchanged 19.')
  })

  it('refuses a non-collaborator with a comment and never runs the job', async () => {
    const observeComment = new utils.ObserveRequest()
    server.use(
      http.get(`${repo}/collaborators/Codertocat`, utils.mockResponse(404)),
      http.post(`${repo}/issues/1/comments`, utils.mockResponse(201, {}, observeComment)),
    )

    await handleIssueComment(commentContext())

    await observeComment.called()
    expect(job.labelSync).not.toHaveBeenCalled()
    expect((await observeComment.body()).body).toBe('@Codertocat: only collaborators may run `/label-sync`.')
  })

  it('fails the run when the job refuses a write', async () => {
    vi.mocked(job.labelSync).mockRejectedValue(new Error('1 label(s) could not be synced: lgtm (403)'))
    const failures: string[] = []
    const { setPlatform, platform } = await import('../../src/platform')
    const base = platform()
    setPlatform({ ...base, fail: message => failures.push(message) })
    server.use(http.get(`${repo}/collaborators/Codertocat`, utils.mockResponse(204)))

    await handleIssueComment(commentContext())

    expect(failures).toHaveLength(1)
    expect(failures[0]).toContain('1 label(s) could not be synced: lgtm (403)')
  })

  it('throws on a payload without an issue', async () => {
    const { labelSyncCommand } = await import('../../src/issueComment/labelSync')
    const context = new utils.MockContext({ ...structuredClone(issueCommentEvent), issue: undefined })

    await expect(labelSyncCommand(context)).rejects.toThrow(/missing issue number/)
  })
})
