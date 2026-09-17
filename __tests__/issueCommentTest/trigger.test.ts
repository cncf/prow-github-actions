import type { HttpHandler } from 'msw'
import process from 'node:process'
import * as core from '@actions/core'
import { http } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { handleIssueComment } from '../../src/issueComment/handleIssueComment'
import issueCommentEvent from '../fixtures/issues/issueCommentEvent.json'
import * as utils from '../testUtils'
import { prCommentEvent, prHandlers, repo } from '../utils/ownersFixtures'

const server = setupServer()
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterEach(() => {
  server.resetHandlers()
  server.events.removeAllListeners()
})
afterAll(() => server.close())

const headSha = 'headsha'
const reactionUrl = `${repo}/issues/comments/492700400/reactions`

interface RunSpec {
  id: number
  name: string
  path?: string
  status: string
  conclusion?: string | null
}

function run(spec: RunSpec) {
  return {
    id: spec.id,
    name: spec.name,
    path: spec.path ?? `.github/workflows/${spec.name.toLowerCase().replace(/\s+/g, '-')}.yml`,
    head_sha: headSha,
    status: spec.status,
    conclusion: spec.conclusion ?? null,
  }
}

// the workflow runs on the head sha; pages of `pageSize` so a test may exercise pagination
function serveRuns(specs: RunSpec[], observe?: utils.ObserveRequest, pageSize = 100): HttpHandler {
  const runs = specs.map(run)
  return http.get(`${repo}/actions/runs`, ({ request }) => {
    if (observe)
      observe.ref = request
    const url = new URL(request.url)
    const page = Number(url.searchParams.get('page') ?? '1')
    const slice = runs.slice((page - 1) * pageSize, page * pageSize)
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (page * pageSize < runs.length) {
      url.searchParams.set('page', String(page + 1))
      headers.Link = `<${url}>; rel="next"`
    }
    return new Response(JSON.stringify({ total_count: runs.length, workflow_runs: slice }), { status: 200, headers })
  })
}

// an org member with no OWNERS files in the repository
function memberAuth(login = 'Codertocat'): HttpHandler[] {
  return [
    http.get(`${utils.api}/orgs/Codertocat/members/${login}`, utils.mockResponse(204)),
    http.get(`${repo}/collaborators/${login}`, utils.mockResponse(404)),
    ...prHandlers({}, ['src/file1.txt']),
  ]
}

function outsiderAuth(login = 'Codertocat'): HttpHandler[] {
  return [
    http.get(`${utils.api}/orgs/Codertocat/members/${login}`, utils.mockResponse(404)),
    http.get(`${repo}/collaborators/${login}`, utils.mockResponse(404)),
    ...prHandlers({}, ['src/file1.txt']),
  ]
}

let calls: string[]
beforeEach(() => {
  calls = []
  server.events.on('request:start', ({ request }) => {
    calls.push(`${request.method} ${new URL(request.url).pathname}`)
  })
})

function setup(command: string) {
  utils.setupActionsEnv(command)
  process.env.GITHUB_WORKFLOW = 'Prow'
}

const mixedRuns: RunSpec[] = [
  { id: 1, name: 'CI', status: 'completed', conclusion: 'failure' },
  { id: 2, name: 'Lint', status: 'completed', conclusion: 'success' },
  { id: 3, name: 'E2E', status: 'in_progress' },
  { id: 4, name: 'Docs', status: 'completed', conclusion: 'cancelled' },
  // the workflow this very command runs in; re-running it would loop
  { id: 5, name: 'Prow', path: '.github/workflows/prow.yml', status: 'in_progress' },
]

describe('/retest', () => {
  beforeEach(() => setup('/retest'))

  it('re-runs the failed jobs of every failed or cancelled run on the head, then reacts with a rocket', async () => {
    const reaction = new utils.ObserveRequest()
    const reruns: number[] = []
    server.use(
      ...memberAuth(),
      serveRuns(mixedRuns),
      http.post(`${repo}/actions/runs/:id/rerun-failed-jobs`, ({ params }) => {
        reruns.push(Number(params.id))
        return new Response(null, { status: 201 })
      }),
      http.post(reactionUrl, utils.mockResponse(201, { content: 'rocket' }, reaction)),
    )
    const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})

    await handleIssueComment(new utils.MockContext(prCommentEvent('/retest')))

    await expect(reaction.called()).resolves.toBe('called')
    expect(await reaction.body()).toEqual({ content: 'rocket' })
    expect(reruns.sort()).toEqual([1, 4])
    expect(calls.filter(c => c.endsWith('/rerun'))).toEqual([])
    expect(calls.filter(c => c === `POST /repos/Codertocat/Hello-World/issues/1/comments`)).toEqual([])
    expect(setFailed).not.toHaveBeenCalled()
    const runsRead = calls.filter(c => c === 'GET /repos/Codertocat/Hello-World/actions/runs')
    expect(runsRead).toHaveLength(1)
  })

  it('lists the runs by head sha, 100 per page', async () => {
    const list = new utils.ObserveRequest()
    server.use(
      ...memberAuth(),
      serveRuns(mixedRuns, list),
      http.post(`${repo}/actions/runs/:id/rerun-failed-jobs`, utils.mockResponse(201)),
      http.post(reactionUrl, utils.mockResponse(201, {})),
    )

    await handleIssueComment(new utils.MockContext(prCommentEvent('/retest')))

    await expect(list.called()).resolves.toBe('called')
    const url = new URL(list.ref!.url)
    expect(url.searchParams.get('head_sha')).toBe(headSha)
    expect(url.searchParams.get('per_page')).toBe('100')
  })

  it('follows the pages of a long run list', async () => {
    const many: RunSpec[] = Array.from({ length: 150 }, (_, i) => ({ id: i + 10, name: `W${i}`, status: 'completed', conclusion: i === 149 ? 'failure' : 'success' }))
    const reruns: number[] = []
    server.use(
      ...memberAuth(),
      serveRuns(many, undefined, 100),
      http.post(`${repo}/actions/runs/:id/rerun-failed-jobs`, ({ params }) => {
        reruns.push(Number(params.id))
        return new Response(null, { status: 201 })
      }),
      http.post(reactionUrl, utils.mockResponse(201, {})),
    )

    await handleIssueComment(new utils.MockContext(prCommentEvent('/retest')))

    expect(reruns).toEqual([159])
    expect(calls.filter(c => c === 'GET /repos/Codertocat/Hello-World/actions/runs')).toHaveLength(2)
  })

  it('comments, without reacting, when nothing failed', async () => {
    const reply = new utils.ObserveRequest()
    const reaction = new utils.ObserveRequest()
    const rerun = new utils.ObserveRequest()
    server.use(
      ...memberAuth(),
      serveRuns([
        { id: 2, name: 'Lint', status: 'completed', conclusion: 'success' },
        { id: 3, name: 'E2E', status: 'in_progress' },
        { id: 6, name: 'Unit', status: 'queued' },
      ]),
      http.post(`${repo}/actions/runs/:id/rerun-failed-jobs`, utils.mockResponse(201, null, rerun)),
      http.post(`${repo}/issues/1/comments`, utils.mockResponse(201, {}, reply)),
      http.post(reactionUrl, utils.mockResponse(201, {}, reaction)),
    )
    const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})

    await handleIssueComment(new utils.MockContext(prCommentEvent('/retest')))

    await expect(reply.called()).resolves.toBe('called')
    expect((await reply.body()).body).toBe('No failed GitHub Actions workflow runs on `headsha`: 2 in progress, 1 successful. Checks from other CI systems cannot be re-run here.')
    await expect(reaction.notCalled()).resolves.toBe('not called')
    await expect(rerun.notCalled()).resolves.toBe('not called')
    expect(setFailed).not.toHaveBeenCalled()
  })

  it('omits the zero parts of the nothing-failed comment', async () => {
    const reply = new utils.ObserveRequest()
    server.use(
      ...memberAuth(),
      serveRuns([{ id: 2, name: 'Lint', status: 'completed', conclusion: 'success' }]),
      http.post(`${repo}/issues/1/comments`, utils.mockResponse(201, {}, reply)),
    )

    await handleIssueComment(new utils.MockContext(prCommentEvent('/retest')))

    await expect(reply.called()).resolves.toBe('called')
    expect((await reply.body()).body).toBe('No failed GitHub Actions workflow runs on `headsha`: 1 successful. Checks from other CI systems cannot be re-run here.')
  })

  it('a 409 on one run skips it and the others are still re-run with a rocket', async () => {
    const reaction = new utils.ObserveRequest()
    const reruns: number[] = []
    server.use(
      ...memberAuth(),
      serveRuns(mixedRuns),
      http.post(`${repo}/actions/runs/:id/rerun-failed-jobs`, ({ params }) => {
        reruns.push(Number(params.id))
        return new Response(JSON.stringify({ message: 'This workflow run is already being re-run' }), { status: Number(params.id) === 1 ? 409 : 201, headers: { 'Content-Type': 'application/json' } })
      }),
      http.post(reactionUrl, utils.mockResponse(201, {}, reaction)),
    )
    const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})
    const debug = vi.spyOn(core, 'debug')

    await handleIssueComment(new utils.MockContext(prCommentEvent('/retest')))

    await expect(reaction.called()).resolves.toBe('called')
    expect(reruns.sort()).toEqual([1, 4])
    expect(debug).toHaveBeenCalledWith(expect.stringContaining('run 1 (CI) is not completed or already re-running'))
    expect(setFailed).not.toHaveBeenCalled()
  })

  it('when every candidate answers 409 it comments that they are already being re-run', async () => {
    const reply = new utils.ObserveRequest()
    const reaction = new utils.ObserveRequest()
    server.use(
      ...memberAuth(),
      serveRuns(mixedRuns),
      http.post(`${repo}/actions/runs/:id/rerun-failed-jobs`, utils.mockResponse(409, { message: 'already being re-run' })),
      http.post(`${repo}/issues/1/comments`, utils.mockResponse(201, {}, reply)),
      http.post(reactionUrl, utils.mockResponse(201, {}, reaction)),
    )
    const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})

    await handleIssueComment(new utils.MockContext(prCommentEvent('/retest')))

    await expect(reply.called()).resolves.toBe('called')
    expect((await reply.body()).body).toBe('The failed GitHub Actions workflow runs on `headsha` are already being re-run.')
    await expect(reaction.notCalled()).resolves.toBe('not called')
    expect(setFailed).not.toHaveBeenCalled()
  })

  it('a 403 fails the run with the permission to grant and reacts with nothing', async () => {
    const reply = new utils.ObserveRequest()
    const reaction = new utils.ObserveRequest()
    server.use(
      ...memberAuth(),
      serveRuns(mixedRuns),
      http.post(`${repo}/actions/runs/:id/rerun-failed-jobs`, utils.mockResponse(403, { message: 'Resource not accessible by integration' })),
      http.post(`${repo}/issues/1/comments`, utils.mockResponse(201, {}, reply)),
      http.post(reactionUrl, utils.mockResponse(201, {}, reaction)),
    )
    const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})
    vi.spyOn(core, 'error').mockImplementation(() => {})

    await handleIssueComment(new utils.MockContext(prCommentEvent('/retest')))

    const wantErr = 'cannot re-run workflows: grant `actions: write` to the workflow'
    await expect(reply.called()).resolves.toBe('called')
    expect((await reply.body()).body).toBe(wantErr)
    await expect(reaction.notCalled()).resolves.toBe('not called')
    expect(setFailed).toHaveBeenCalledWith(expect.stringContaining(wantErr))
  })

  it('any other re-run failure fails the run', async () => {
    server.use(
      ...memberAuth(),
      serveRuns(mixedRuns),
      http.post(`${repo}/actions/runs/:id/rerun-failed-jobs`, utils.mockResponse(500, { message: 'boom' })),
    )
    const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})

    await handleIssueComment(new utils.MockContext(prCommentEvent('/retest')))

    expect(setFailed).toHaveBeenCalledWith(expect.stringContaining('could not re-run'))
  })

  it('a failed run listing fails the run', async () => {
    server.use(
      ...memberAuth(),
      http.get(`${repo}/actions/runs`, utils.mockResponse(500, { message: 'boom' })),
    )
    const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})

    await handleIssueComment(new utils.MockContext(prCommentEvent('/retest')))

    expect(setFailed).toHaveBeenCalledWith(expect.stringContaining('could not list the workflow runs of headsha'))
  })

  it('refuses an outsider with the lgtm message and makes no Actions call', async () => {
    const reply = new utils.ObserveRequest()
    const runs = new utils.ObserveRequest()
    server.use(
      ...outsiderAuth(),
      serveRuns(mixedRuns, runs),
      http.post(`${repo}/issues/1/comments`, utils.mockResponse(201, {}, reply)),
    )
    const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})
    vi.spyOn(core, 'error').mockImplementation(() => {})

    await handleIssueComment(new utils.MockContext(prCommentEvent('/retest')))

    const wantErr = 'Codertocat is not a org member or collaborator'
    await expect(reply.called()).resolves.toBe('called')
    expect((await reply.body()).body).toBe(`Cannot /retest because Error: ${wantErr}`)
    await expect(runs.notCalled()).resolves.toBe('not called')
    expect(setFailed).toHaveBeenCalledWith(expect.stringContaining(wantErr))
  })

  it('an OWNERS reviewer of a changed file without membership is allowed (the lgtm rule)', async () => {
    const reaction = new utils.ObserveRequest()
    server.use(
      ...prHandlers({ 'sdk/OWNERS': 'reviewers:\n- ryan\n' }, ['sdk/x.go']),
      serveRuns(mixedRuns),
      http.post(`${repo}/actions/runs/:id/rerun-failed-jobs`, utils.mockResponse(201)),
      http.post(reactionUrl, utils.mockResponse(201, {}, reaction)),
    )
    const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})

    await handleIssueComment(new utils.MockContext(prCommentEvent('/retest', 'ryan')))

    await expect(reaction.called()).resolves.toBe('called')
    expect(calls.some(c => c.includes('/orgs/'))).toBe(false)
    expect(setFailed).not.toHaveBeenCalled()
  })

  it('lets an org-member author retest their own pull request', async () => {
    const reaction = new utils.ObserveRequest()
    server.use(
      ...memberAuth(),
      serveRuns(mixedRuns),
      http.post(`${repo}/actions/runs/:id/rerun-failed-jobs`, utils.mockResponse(201)),
      http.post(reactionUrl, utils.mockResponse(201, {}, reaction)),
    )
    const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})

    await handleIssueComment(new utils.MockContext(prCommentEvent('/retest', 'Codertocat', 'Codertocat')))

    await expect(reaction.called()).resolves.toBe('called')
    expect(setFailed).not.toHaveBeenCalled()
  })

  it('on an issue comments that it only applies to pull requests and makes no Actions call', async () => {
    const reply = new utils.ObserveRequest()
    const runs = new utils.ObserveRequest()
    const event = structuredClone(issueCommentEvent)
    event.comment.body = '/retest'
    server.use(
      serveRuns(mixedRuns, runs),
      http.post(`${repo}/issues/1/comments`, utils.mockResponse(201, {}, reply)),
    )
    const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})

    await handleIssueComment(new utils.MockContext(event))

    await expect(reply.called()).resolves.toBe('called')
    expect((await reply.body()).body).toBe('`/retest` only applies to pull requests.')
    await expect(runs.notCalled()).resolves.toBe('not called')
    expect(calls).toEqual(['POST /repos/Codertocat/Hello-World/issues/1/comments'])
    expect(setFailed).not.toHaveBeenCalled()
  })

  it('a failed reaction is only a warning', async () => {
    server.use(
      ...memberAuth(),
      serveRuns(mixedRuns),
      http.post(`${repo}/actions/runs/:id/rerun-failed-jobs`, utils.mockResponse(201)),
      http.post(reactionUrl, utils.mockResponse(500, { message: 'boom' })),
    )
    const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})
    const warning = vi.spyOn(core, 'warning').mockImplementation(() => {})

    await handleIssueComment(new utils.MockContext(prCommentEvent('/retest')))

    expect(warning).toHaveBeenCalledWith(expect.stringContaining('could not react to the comment'))
    expect(setFailed).not.toHaveBeenCalled()
  })

  it('runs no post-command sweep: no configuration or pull request state is read after the re-run', async () => {
    server.use(
      ...memberAuth(),
      serveRuns(mixedRuns),
      http.post(`${repo}/actions/runs/:id/rerun-failed-jobs`, utils.mockResponse(201)),
      http.post(reactionUrl, utils.mockResponse(201, {})),
    )

    await handleIssueComment(new utils.MockContext(prCommentEvent('/retest')))

    expect(calls.some(c => c.includes('/contents/'))).toBe(false)
    expect(calls.filter(c => c === 'GET /repos/Codertocat/Hello-World/pulls/1')).toHaveLength(1)
  })
})

describe('/test', () => {
  beforeEach(() => setup('/test'))

  function serveRerun(reruns: number[]): HttpHandler {
    return http.post(`${repo}/actions/runs/:id/rerun`, ({ params }) => {
      reruns.push(Number(params.id))
      return new Response(null, { status: 201 })
    })
  }

  it('/test all re-runs every completed run except the current workflow', async () => {
    const reaction = new utils.ObserveRequest()
    const reruns: number[] = []
    server.use(...memberAuth(), serveRuns(mixedRuns), serveRerun(reruns), http.post(reactionUrl, utils.mockResponse(201, {}, reaction)))
    const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})

    await handleIssueComment(new utils.MockContext(prCommentEvent('/test all')))

    await expect(reaction.called()).resolves.toBe('called')
    expect(reruns.sort()).toEqual([1, 2, 4])
    expect(calls.filter(c => c.endsWith('/rerun-failed-jobs'))).toEqual([])
    expect(setFailed).not.toHaveBeenCalled()
  })

  it.each(['/test ci', '/test CI', '/test ci.yml'])('%s matches the workflow by name or file basename', async (body) => {
    const reruns: number[] = []
    server.use(...memberAuth(), serveRuns(mixedRuns), serveRerun(reruns), http.post(reactionUrl, utils.mockResponse(201, {})))

    await handleIssueComment(new utils.MockContext(prCommentEvent(body)))

    expect(reruns).toEqual([1])
  })

  it('matches a display name that differs from the file name by either', async () => {
    const reruns: number[] = []
    server.use(
      ...memberAuth(),
      serveRuns([{ id: 7, name: 'Build and Test', path: '.github/workflows/build.yml', status: 'completed', conclusion: 'success' }]),
      serveRerun(reruns),
      http.post(reactionUrl, utils.mockResponse(201, {})),
    )

    await handleIssueComment(new utils.MockContext(prCommentEvent('/test build')))
    expect(reruns).toEqual([7])
  })

  it('unions the lines of several /test commands in one comment', async () => {
    const reruns: number[] = []
    server.use(...memberAuth(), serveRuns(mixedRuns), serveRerun(reruns), http.post(reactionUrl, utils.mockResponse(201, {})))

    await handleIssueComment(new utils.MockContext(prCommentEvent('/test ci\n/test docs')))

    expect(reruns.sort()).toEqual([1, 4])
  })

  it('an unknown name comments the available runs, no re-run, no rocket', async () => {
    const reply = new utils.ObserveRequest()
    const reaction = new utils.ObserveRequest()
    const reruns: number[] = []
    server.use(
      ...memberAuth(),
      serveRuns(mixedRuns),
      serveRerun(reruns),
      http.post(`${repo}/issues/1/comments`, utils.mockResponse(201, {}, reply)),
      http.post(reactionUrl, utils.mockResponse(201, {}, reaction)),
    )
    const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})

    await handleIssueComment(new utils.MockContext(prCommentEvent('/test nope')))

    await expect(reply.called()).resolves.toBe('called')
    const body = (await reply.body()).body as string
    expect(body).toContain('No completed GitHub Actions workflow run on `headsha` matches `nope`.')
    expect(body).toContain('`CI` | completed | failure')
    expect(body).toContain('`E2E` | in_progress | ')
    expect(body).not.toContain('`Prow`')
    expect(reruns).toEqual([])
    await expect(reaction.notCalled()).resolves.toBe('not called')
    expect(setFailed).not.toHaveBeenCalled()
  })

  it.each(['/test ?', '/test'])('%s lists the runs as a table', async (body) => {
    const reply = new utils.ObserveRequest()
    server.use(...memberAuth(), serveRuns(mixedRuns), http.post(`${repo}/issues/1/comments`, utils.mockResponse(201, {}, reply)))

    await handleIssueComment(new utils.MockContext(prCommentEvent(body)))

    await expect(reply.called()).resolves.toBe('called')
    expect((await reply.body()).body).toBe([
      'Workflow runs on `headsha`:',
      '',
      'workflow | status | conclusion',
      '--- | --- | ---',
      '`CI` | completed | failure',
      '`Lint` | completed | success',
      '`E2E` | in_progress | ',
      '`Docs` | completed | cancelled',
    ].join('\n'))
    expect(calls.some(c => c.includes('/actions/runs/'))).toBe(false)
  })

  it('a 403 on the re-run fails with the actions: write hint', async () => {
    const reply = new utils.ObserveRequest()
    server.use(
      ...memberAuth(),
      serveRuns(mixedRuns),
      http.post(`${repo}/actions/runs/:id/rerun`, utils.mockResponse(403, { message: 'Resource not accessible by integration' })),
      http.post(`${repo}/issues/1/comments`, utils.mockResponse(201, {}, reply)),
    )
    const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})
    vi.spyOn(core, 'error').mockImplementation(() => {})

    await handleIssueComment(new utils.MockContext(prCommentEvent('/test all')))

    await expect(reply.called()).resolves.toBe('called')
    expect((await reply.body()).body).toBe('cannot re-run workflows: grant `actions: write` to the workflow')
    expect(setFailed).toHaveBeenCalledWith(expect.stringContaining('actions: write'))
  })

  it('when every selected run answers 409 it says so', async () => {
    const reply = new utils.ObserveRequest()
    server.use(
      ...memberAuth(),
      serveRuns(mixedRuns),
      http.post(`${repo}/actions/runs/:id/rerun`, utils.mockResponse(409, { message: 'already re-running' })),
      http.post(`${repo}/issues/1/comments`, utils.mockResponse(201, {}, reply)),
    )

    await handleIssueComment(new utils.MockContext(prCommentEvent('/test ci')))

    await expect(reply.called()).resolves.toBe('called')
    expect((await reply.body()).body).toBe('The GitHub Actions workflow runs on `headsha` are already being re-run.')
  })

  it('on an issue comments that it only applies to pull requests', async () => {
    const reply = new utils.ObserveRequest()
    const event = structuredClone(issueCommentEvent)
    event.comment.body = '/test all'
    server.use(http.post(`${repo}/issues/1/comments`, utils.mockResponse(201, {}, reply)))

    await handleIssueComment(new utils.MockContext(event))

    await expect(reply.called()).resolves.toBe('called')
    expect((await reply.body()).body).toBe('`/test` only applies to pull requests.')
  })

  it('refuses an outsider', async () => {
    const reply = new utils.ObserveRequest()
    server.use(...outsiderAuth(), http.post(`${repo}/issues/1/comments`, utils.mockResponse(201, {}, reply)))
    const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})
    vi.spyOn(core, 'error').mockImplementation(() => {})

    await handleIssueComment(new utils.MockContext(prCommentEvent('/test all')))

    await expect(reply.called()).resolves.toBe('called')
    expect((await reply.body()).body).toContain('Cannot /test because')
    expect(setFailed).toHaveBeenCalled()
  })
})

describe('/ok-to-test', () => {
  // the label write is followed by the post-command sweep: no prow.yaml, no OWNERS files, tide skips a pr without lgtm
  beforeEach(() => {
    setup('/ok-to-test')
    server.use(...utils.noOrgOrRepoConfigExcept(), utils.defaultBranchTree())
  })

  const pendingRuns: RunSpec[] = [
    { id: 8, name: 'CI', status: 'action_required', conclusion: 'action_required' },
    { id: 9, name: 'Lint', status: 'completed', conclusion: 'action_required' },
    { id: 2, name: 'Docs', status: 'completed', conclusion: 'success' },
    { id: 5, name: 'Prow', path: '.github/workflows/prow.yml', status: 'in_progress' },
  ]

  function serveApprove(approved: number[]): HttpHandler {
    return http.post(`${repo}/actions/runs/:id/approve`, ({ params }) => {
      approved.push(Number(params.id))
      return new Response(null, { status: 201 })
    })
  }

  it('approves the runs waiting for approval, adds the ok-to-test label and reacts with a rocket', async () => {
    const approved: number[] = []
    const label = new utils.ObserveRequest()
    const reaction = new utils.ObserveRequest()
    server.use(
      ...memberAuth(),
      serveRuns(pendingRuns),
      serveApprove(approved),
      http.get(`${repo}/issues/1`, utils.mockResponse(200, { labels: [] })),
      utils.repoHasLabels(['ok-to-test']),
      http.post(`${repo}/issues/1/labels`, utils.mockResponse(200, [], label)),
      http.post(reactionUrl, utils.mockResponse(201, {}, reaction)),
    )
    const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})

    await handleIssueComment(new utils.MockContext(prCommentEvent('/ok-to-test')))

    await expect(label.called()).resolves.toBe('called')
    expect(await label.body()).toEqual({ labels: ['ok-to-test'] })
    await expect(reaction.called()).resolves.toBe('called')
    expect(approved.sort()).toEqual([8, 9])
    expect(setFailed).not.toHaveBeenCalled()
  })

  it('with nothing pending still reacts when the label was just added', async () => {
    const reaction = new utils.ObserveRequest()
    const reply = new utils.ObserveRequest()
    server.use(
      ...memberAuth(),
      serveRuns([{ id: 2, name: 'Docs', status: 'completed', conclusion: 'success' }]),
      http.get(`${repo}/issues/1`, utils.mockResponse(200, { labels: [] })),
      utils.repoHasLabels(['ok-to-test']),
      http.post(`${repo}/issues/1/labels`, utils.mockResponse(200, [])),
      http.post(`${repo}/issues/1/comments`, utils.mockResponse(201, {}, reply)),
      http.post(reactionUrl, utils.mockResponse(201, {}, reaction)),
    )

    await handleIssueComment(new utils.MockContext(prCommentEvent('/ok-to-test')))

    await expect(reaction.called()).resolves.toBe('called')
    await expect(reply.notCalled()).resolves.toBe('not called')
  })

  it('with the label already present and nothing pending comments instead of reacting, and re-adds nothing', async () => {
    const reaction = new utils.ObserveRequest()
    const reply = new utils.ObserveRequest()
    const label = new utils.ObserveRequest()
    server.use(
      ...memberAuth(),
      serveRuns([{ id: 2, name: 'Docs', status: 'completed', conclusion: 'success' }]),
      http.get(`${repo}/issues/1`, utils.mockResponse(200, { labels: [{ name: 'ok-to-test' }] })),
      http.post(`${repo}/issues/1/labels`, utils.mockResponse(200, [], label)),
      http.post(`${repo}/issues/1/comments`, utils.mockResponse(201, {}, reply)),
      http.post(reactionUrl, utils.mockResponse(201, {}, reaction)),
    )
    const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})

    await handleIssueComment(new utils.MockContext(prCommentEvent('/ok-to-test')))

    await expect(reply.called()).resolves.toBe('called')
    expect((await reply.body()).body).toBe('No workflow runs waiting for approval on `headsha`.')
    await expect(reaction.notCalled()).resolves.toBe('not called')
    await expect(label.notCalled()).resolves.toBe('not called')
    expect(setFailed).not.toHaveBeenCalled()
  })

  it('is refused for the pull request author', async () => {
    const reply = new utils.ObserveRequest()
    const runs = new utils.ObserveRequest()
    server.use(
      ...memberAuth(),
      serveRuns(pendingRuns, runs),
      http.post(`${repo}/issues/1/comments`, utils.mockResponse(201, {}, reply)),
    )
    const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})
    vi.spyOn(core, 'error').mockImplementation(() => {})

    await handleIssueComment(new utils.MockContext(prCommentEvent('/ok-to-test', 'Codertocat', 'Codertocat')))

    const wantErr = 'you cannot approve the workflow runs of your own pull request'
    await expect(reply.called()).resolves.toBe('called')
    expect((await reply.body()).body).toBe(wantErr)
    await expect(runs.notCalled()).resolves.toBe('not called')
    expect(setFailed).toHaveBeenCalledWith(expect.stringContaining(wantErr))
  })

  it('surfaces the missing-label error when the repository has no ok-to-test label', async () => {
    const approved: number[] = []
    server.use(
      ...memberAuth(),
      serveRuns(pendingRuns),
      serveApprove(approved),
      http.get(`${repo}/issues/1`, utils.mockResponse(200, { labels: [] })),
      utils.repoHasLabels(['lgtm']),
    )
    const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})

    await handleIssueComment(new utils.MockContext(prCommentEvent('/ok-to-test')))

    expect(setFailed).toHaveBeenCalledWith(expect.stringContaining('the label(s) ok-to-test cannot be applied because the repository doesn\'t have them'))
  })

  it('a 403 on the approval fails with the actions: write hint', async () => {
    const reply = new utils.ObserveRequest()
    server.use(
      ...memberAuth(),
      serveRuns(pendingRuns),
      http.post(`${repo}/actions/runs/:id/approve`, utils.mockResponse(403, { message: 'Resource not accessible by integration' })),
      http.post(`${repo}/issues/1/comments`, utils.mockResponse(201, {}, reply)),
    )
    const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})

    await handleIssueComment(new utils.MockContext(prCommentEvent('/ok-to-test')))

    expect(setFailed).toHaveBeenCalledWith(expect.stringContaining('cannot approve workflow runs: grant `actions: write` to the workflow'))
  })

  it('on an issue comments that it only applies to pull requests', async () => {
    const reply = new utils.ObserveRequest()
    const event = structuredClone(issueCommentEvent)
    event.comment.body = '/ok-to-test'
    server.use(http.post(`${repo}/issues/1/comments`, utils.mockResponse(201, {}, reply)))

    await handleIssueComment(new utils.MockContext(event))

    await expect(reply.called()).resolves.toBe('called')
    expect((await reply.body()).body).toBe('`/ok-to-test` only applies to pull requests.')
  })
})
