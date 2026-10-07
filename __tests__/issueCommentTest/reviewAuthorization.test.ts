import { Buffer } from 'node:buffer'
import process from 'node:process'
import * as core from '@actions/core'
import { http } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { approve } from '../../src/issueComment/approve'
import { retest } from '../../src/issueComment/trigger'
import { lgtm } from '../../src/labels/lgtm'
import issueCommentEvent from '../fixtures/issues/issueCommentEvent.json'
import * as utils from '../testUtils'
import { prCommentEvent, prHandlers } from '../utils/ownersFixtures'

const server = setupServer()
beforeAll(() => server.listen(utils.failOnUnhandledRequest))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

const repo = `${utils.api}/repos/Codertocat/Hello-World`
const trusted = 'authorization:\n  review: trusted\n  users: [Friend]\n'

let calls: string[]
function recordCall({ request }: { request: Request }) {
  calls.push(`${request.method} ${new URL(request.url).pathname}`)
}

beforeEach(() => {
  utils.setupActionsEnv()
  process.env.GITHUB_WORKFLOW = 'Prow'
  calls = []
  server.events.on('request:start', recordCall)
})

// the server outlives the test; an unremoved listener would record every later request again
afterEach(() => {
  server.events.removeListener('request:start', recordCall)
})

function prowYaml(text: string) {
  return [
    http.get(utils.contentsUrl('.github/prow.yaml'), utils.mockResponse(200, { type: 'file', encoding: 'base64', content: Buffer.from(text).toString('base64') })),
    ...utils.noOrgOrRepoConfigExcept('.github/prow.yaml'),
  ]
}

function membership(login: string, { member = false, collaborator = false } = {}) {
  return [
    http.get(`${utils.api}/orgs/Codertocat/members/${login}`, utils.mockResponse(member ? 204 : 404)),
    http.get(`${repo}/collaborators/${login}`, utils.mockResponse(collaborator ? 204 : 404)),
  ]
}

function issueComment(body: string, commenter: string, author = 'some-author') {
  const event = structuredClone(issueCommentEvent)
  event.comment.body = body
  event.comment.user.login = commenter
  event.issue.user.login = author
  return new utils.MockContext(event)
}

function configRead(call: string) {
  return /\/contents\/(?:prow\.yaml|\.github%2Fprow\.yaml)$/.test(call)
}

describe('authorization.review on a repository without OWNERS files', () => {
  it('/lgtm by a member is admitted without reading the configuration', async () => {
    const label = new utils.ObserveRequest()
    server.use(
      http.get(`${repo}/contents/OWNERS`, utils.mockResponse(404)),
      ...membership('maria', { member: true }),
      utils.repoHasLabels(['lgtm']),
      http.post(`${repo}/issues/1/labels`, utils.mockResponse(200, [], label)),
    )

    await lgtm(issueComment('/lgtm', 'maria'))

    expect(await label.body()).toEqual({ labels: ['lgtm'] })
    expect(calls.filter(configRead)).toEqual([])
  })

  it('/lgtm under trusted admits a users login who is neither member nor collaborator', async () => {
    const label = new utils.ObserveRequest()
    server.use(
      ...prowYaml(trusted),
      http.get(`${repo}/contents/OWNERS`, utils.mockResponse(404)),
      ...membership('friend'),
      utils.repoHasLabels(['lgtm']),
      http.post(`${repo}/issues/1/labels`, utils.mockResponse(200, [], label)),
    )

    await lgtm(issueComment('/lgtm', 'friend'))

    expect(await label.body()).toEqual({ labels: ['lgtm'] })
  })

  it('/lgtm under trusted on a pull request admits a users login and binds the head commit', async () => {
    const status = new utils.ObserveRequest()
    const label = new utils.ObserveRequest()
    server.use(
      ...prowYaml(trusted),
      ...prHandlers({}, ['src/file1.txt']),
      ...membership('friend'),
      http.post(`${repo}/statuses/headsha`, utils.mockResponse(201, {}, status)),
      utils.repoHasLabels(['lgtm']),
      http.post(`${repo}/issues/1/labels`, utils.mockResponse(200, [], label)),
    )

    await lgtm(new utils.MockContext(prCommentEvent('/lgtm', 'friend')))

    expect(await status.body()).toMatchObject({ context: 'prow/lgtm', state: 'success' })
    expect(await label.body()).toEqual({ labels: ['lgtm'] })
  })

  it('/lgtm under trusted still refuses the pull request author, even a users login', async () => {
    const reply = new utils.ObserveRequest()
    server.use(
      ...prowYaml(trusted),
      http.post(`${repo}/issues/1/comments`, utils.mockResponse(201, {}, reply)),
    )
    vi.spyOn(core, 'error').mockImplementation(() => {})

    await expect(lgtm(new utils.MockContext(prCommentEvent('/lgtm', 'friend', 'friend')))).rejects.toThrow('you cannot LGTM your own PR.')
    expect((await reply.body()).body).toBe('you cannot LGTM your own PR.')
    expect(calls.some(call => call.endsWith('/labels'))).toBe(false)
  })

  it('/lgtm under trusted refuses an outsider with the authorization.users message', async () => {
    const reply = new utils.ObserveRequest()
    server.use(
      ...prowYaml(trusted),
      http.get(`${repo}/contents/OWNERS`, utils.mockResponse(404)),
      ...membership('outsider'),
      http.post(`${repo}/issues/1/comments`, utils.mockResponse(201, {}, reply)),
    )
    vi.spyOn(core, 'error').mockImplementation(() => {})

    await expect(lgtm(issueComment('/lgtm', 'outsider'))).rejects.toThrow('outsider is not a org member, collaborator or listed in authorization.users')
    expect((await reply.body()).body).toContain('outsider is not a org member, collaborator or listed in authorization.users')
  })

  it('/approve under trusted on a pull request admits a users login', async () => {
    const review = new utils.ObserveRequest()
    server.use(
      ...prowYaml(trusted),
      ...prHandlers({}, ['src/file1.txt']),
      ...membership('friend'),
      http.post(`${repo}/pulls/1/reviews`, utils.mockResponse(200, {}, review)),
    )

    await approve(new utils.MockContext(prCommentEvent('/approve', 'friend')))

    expect(await review.body()).toMatchObject({ event: 'APPROVE' })
  })

  it('/retest under trusted admits a users login and re-runs the failed run', async () => {
    const rerun = new utils.ObserveRequest()
    server.use(
      ...prowYaml(trusted),
      ...prHandlers({}, ['src/file1.txt']),
      ...membership('friend'),
      http.get(`${repo}/actions/runs`, utils.mockResponse(200, {
        total_count: 1,
        workflow_runs: [{ id: 1, name: 'CI', path: '.github/workflows/ci.yml', head_sha: 'headsha', status: 'completed', conclusion: 'failure' }],
      })),
      http.post(`${repo}/actions/runs/1/rerun-failed-jobs`, utils.mockResponse(201, {}, rerun)),
      http.post(`${repo}/issues/comments/492700400/reactions`, utils.mockResponse(201, {})),
    )

    await retest(new utils.MockContext(prCommentEvent('/retest', 'friend')))

    await expect(rerun.called()).resolves.toBe('called')
  })
})
