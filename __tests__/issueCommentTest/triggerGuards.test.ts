import type { HttpHandler } from 'msw'
import process from 'node:process'
import * as core from '@actions/core'
import { http } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { handleIssueComment } from '../../src/issueComment/handleIssueComment'
import { approvePendingRuns, okToTestOnPullRequest, retest } from '../../src/issueComment/trigger'
import { newOctokit } from '../../src/utils/octokit'
import prOpenedEvent from '../fixtures/pullReq/pullReqOpenedEvent.json'
import * as utils from '../testUtils'
import { prCommentEvent, prHandlers, repo } from '../utils/ownersFixtures'

// Guards of src/issueComment/trigger.ts that line coverage reaches but no
// other test would notice changing: each case here fails when the guard it
// names is removed or inverted.

const server = setupServer()
beforeAll(() => server.listen(utils.failOnUnhandledRequest))
afterEach(() => {
  server.resetHandlers()
  server.events.removeAllListeners()
})
afterAll(() => server.close())

const headSha = 'headsha'
const reactionUrl = `${repo}/issues/comments/492700400/reactions`

interface RunSpec {
  id: number
  name: string | null
  path?: string
  status: string
  conclusion?: string | null
}

function serveRuns(specs: RunSpec[]): HttpHandler {
  const runs = specs.map(spec => ({
    id: spec.id,
    name: spec.name,
    path: spec.path ?? `.github/workflows/${(spec.name ?? 'run').toLowerCase().replace(/\s+/g, '-')}.yml`,
    head_sha: headSha,
    status: spec.status,
    conclusion: spec.conclusion ?? null,
  }))
  return http.get(`${repo}/actions/runs`, utils.mockResponse(200, { total_count: runs.length, workflow_runs: runs }))
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

function recordRerun(reruns: number[], route: string): HttpHandler {
  return http.post(`${repo}/actions/runs/:id/${route}`, ({ params }) => {
    reruns.push(Number(params.id))
    return new Response(null, { status: 201 })
  })
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

const failedRun: RunSpec = { id: 1, name: 'CI', status: 'completed', conclusion: 'failure' }

describe('/retest', () => {
  beforeEach(() => setup('/retest'))

  // react: `if (commentId === undefined) return` — without it the reaction is
  // attempted against a comment id of undefined and only its failure is caught
  it('a comment without an id attempts no reaction request and logs no warning', async () => {
    const event = prCommentEvent('/retest') as { comment: { id?: number } }
    delete event.comment.id
    const reruns: number[] = []
    server.use(...memberAuth(), serveRuns([failedRun]), recordRerun(reruns, 'rerun-failed-jobs'))
    const warning = vi.spyOn(core, 'warning').mockImplementation(() => {})
    const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})

    await handleIssueComment(new utils.MockContext(event as never))

    expect(reruns).toEqual([1])
    expect(calls.filter(c => c.includes('/reactions'))).toEqual([])
    expect(warning).not.toHaveBeenCalled()
    expect(setFailed).not.toHaveBeenCalled()
  })

  // refuse: the message is logged as an error annotation, not only commented
  it('a refusal is logged as an error annotation with the full message', async () => {
    server.use(
      ...outsiderAuth(),
      http.post(`${repo}/issues/1/comments`, utils.mockResponse(201, {})),
      ...utils.noOrgOrRepoConfigExcept(),
    )
    vi.spyOn(core, 'setFailed').mockImplementation(() => {})
    const error = vi.spyOn(core, 'error').mockImplementation(() => {})

    await handleIssueComment(new utils.MockContext(prCommentEvent('/retest')))

    expect(error).toHaveBeenCalledWith('Cannot /retest because Error: Codertocat is not a org member or collaborator')
  })

  // prepare: `context.payload.comment?.user?.login` — a comment whose user is
  // gone is refused through the normal path rather than crashing on `.login`
  it('a comment whose user is gone is refused with a comment and makes no Actions call', async () => {
    const event = prCommentEvent('/retest') as { comment: { user: unknown } }
    event.comment.user = null
    const reply = new utils.ObserveRequest()
    server.use(
      // octokit drops the undefined login from both membership probes' paths
      http.get(`${utils.api}/orgs/Codertocat/members`, utils.mockResponse(404)),
      http.get(`${repo}/collaborators`, utils.mockResponse(404)),
      ...prHandlers({}, ['src/file1.txt']),
      http.post(`${repo}/issues/1/comments`, utils.mockResponse(201, {}, reply)),
      ...utils.noOrgOrRepoConfigExcept(),
    )
    const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})
    vi.spyOn(core, 'error').mockImplementation(() => {})

    await handleIssueComment(new utils.MockContext(event as never))

    await expect(reply.called()).resolves.toBe('called')
    expect((await reply.body()).body).toBe('Cannot /retest because Error: undefined is not a org member or collaborator')
    expect(setFailed).toHaveBeenCalledWith(expect.stringContaining('is not a org member or collaborator'))
    expect(setFailed).not.toHaveBeenCalledWith(expect.stringContaining('Cannot read properties'))
    expect(calls.some(c => c.includes('/actions/runs'))).toBe(false)
  })

  // prepare: `core.getInput('github-token', { required: true })` fails fast
  // instead of issuing unauthenticated requests with an empty token
  it('fails before any request when the github-token input is missing', async () => {
    delete process.env['INPUT_GITHUB-TOKEN']

    await expect(retest(new utils.MockContext(prCommentEvent('/retest')))).rejects.toThrow('Input required and not supplied: github-token')
    expect(calls).toEqual([])
  })
})

describe('/test', () => {
  beforeEach(() => setup('/test'))

  // `args.join(' ')`: the no-match comment echoes the arguments as typed
  it('the no-match comment echoes several arguments separated by spaces', async () => {
    const reply = new utils.ObserveRequest()
    server.use(
      ...memberAuth(),
      serveRuns([failedRun]),
      http.post(`${repo}/issues/1/comments`, utils.mockResponse(201, {}, reply)),
    )

    await handleIssueComment(new utils.MockContext(prCommentEvent('/test nope nah')))

    await expect(reply.called()).resolves.toBe('called')
    expect((await reply.body()).body).toContain('matches `nope nah`.')
  })

  // matchesWorkflow: `${arg}.yaml` is one of the file candidates
  it('matches a workflow stored as .yaml by its basename', async () => {
    const reruns: number[] = []
    server.use(
      ...memberAuth(),
      serveRuns([{ id: 7, name: 'Continuous Integration', path: '.github/workflows/ci.yaml', status: 'completed', conclusion: 'success' }]),
      recordRerun(reruns, 'rerun'),
      http.post(reactionUrl, utils.mockResponse(201, {})),
    )

    await handleIssueComment(new utils.MockContext(prCommentEvent('/test ci')))

    expect(reruns).toEqual([7])
  })

  // matchesWorkflow: `path === file` accepts the full workflow path, which no
  // `endsWith('/…')` candidate would
  it('matches a workflow by its full path', async () => {
    const reruns: number[] = []
    server.use(
      ...memberAuth(),
      serveRuns([{ id: 7, name: 'Build and Test', path: '.github/workflows/build.yml', status: 'completed', conclusion: 'success' }]),
      recordRerun(reruns, 'rerun'),
      http.post(reactionUrl, utils.mockResponse(201, {})),
    )

    await handleIssueComment(new utils.MockContext(prCommentEvent('/test .github/workflows/build.yml')))

    expect(reruns).toEqual([7])
  })
})

describe('/ok-to-test', () => {
  // the label write is followed by the post-command sweep: no prow.yaml, no
  // OWNERS files, no merge queue, tide skips a pr without lgtm
  beforeEach(() => {
    setup('/ok-to-test')
    server.use(...utils.noOrgOrRepoConfigExcept(), utils.defaultBranchTree(), utils.mergeQueueGraphql({ enabled: false }).handler)
  })

  const pendingRuns: RunSpec[] = [
    { id: 8, name: 'CI', status: 'action_required', conclusion: 'action_required' },
    { id: 2, name: 'Docs', status: 'completed', conclusion: 'success' },
  ]

  // `label.toLowerCase() === okToTestLabel`: only the ok-to-test label counts
  // as already present, not any label the pull request carries
  it('adds ok-to-test to a pull request that carries only unrelated labels', async () => {
    const approved: number[] = []
    const label = new utils.ObserveRequest()
    server.use(
      ...memberAuth(),
      serveRuns(pendingRuns),
      recordRerun(approved, 'approve'),
      http.get(`${repo}/issues/1`, utils.mockResponse(200, { labels: [{ name: 'kind/bug' }, { name: 'size/S' }] })),
      utils.repoHasLabels(['ok-to-test']),
      http.post(`${repo}/issues/1/labels`, utils.mockResponse(200, [], label)),
      http.post(reactionUrl, utils.mockResponse(201, {})),
    )
    const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})

    await handleIssueComment(new utils.MockContext(prCommentEvent('/ok-to-test')))

    await expect(label.called()).resolves.toBe('called')
    expect(await label.body()).toEqual({ labels: ['ok-to-test'] })
    expect(approved).toEqual([8])
    expect(setFailed).not.toHaveBeenCalled()
  })

  // `approved === 0 && alreadyLabeled`: the no-runs comment is only for a
  // repeat with nothing to approve; approving runs reacts even when labeled
  it('with the label already present and runs approved reacts instead of commenting', async () => {
    const approved: number[] = []
    const reply = new utils.ObserveRequest()
    const reaction = new utils.ObserveRequest()
    server.use(
      ...memberAuth(),
      serveRuns(pendingRuns),
      recordRerun(approved, 'approve'),
      http.get(`${repo}/issues/1`, utils.mockResponse(200, { labels: [{ name: 'ok-to-test' }] })),
      http.post(`${repo}/issues/1/comments`, utils.mockResponse(201, {}, reply)),
      http.post(reactionUrl, utils.mockResponse(201, {}, reaction)),
    )

    await handleIssueComment(new utils.MockContext(prCommentEvent('/ok-to-test')))

    expect(approved).toEqual([8])
    await expect(reaction.called()).resolves.toBe('called')
    await expect(reply.notCalled()).resolves.toBe('not called')
  })

  // prepare: `context.payload.issue?.user?.login` — the author check tolerates
  // a pull request whose author account is gone
  it('on a pull request whose author is gone approves and reacts for a member', async () => {
    const event = prCommentEvent('/ok-to-test') as { issue: { user: unknown } }
    event.issue.user = null
    const approved: number[] = []
    const reaction = new utils.ObserveRequest()
    server.use(
      ...memberAuth(),
      serveRuns(pendingRuns),
      recordRerun(approved, 'approve'),
      http.get(`${repo}/issues/1`, utils.mockResponse(200, { labels: [{ name: 'ok-to-test' }] })),
      http.post(reactionUrl, utils.mockResponse(201, {}, reaction)),
    )
    const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})

    await handleIssueComment(new utils.MockContext(event as never))

    expect(approved).toEqual([8])
    await expect(reaction.called()).resolves.toBe('called')
    expect(setFailed).not.toHaveBeenCalled()
  })

  // approvePendingRuns: `run.status === 'action_required'` is a candidate on
  // its own, before GitHub fills in a conclusion
  it('approves a run that reports action_required by status alone', async () => {
    const approved: number[] = []
    server.use(
      serveRuns([{ id: 11, name: 'CI', status: 'action_required', conclusion: null }]),
      recordRerun(approved, 'approve'),
    )

    await expect(approvePendingRuns(newOctokit('some-token'), new utils.MockContext(prCommentEvent('/ok-to-test')), 1, headSha)).resolves.toBe(1)
    expect(approved).toEqual([11])
  })

  // statusOf: `typeof error === 'object' && error !== null` — a null rejection
  // carries no status and is reported by its string form, not a TypeError
  it('a null approve rejection fails with its string form', async () => {
    server.use(serveRuns(pendingRuns))
    const octokit = newOctokit('some-token')
    vi.spyOn(octokit.actions, 'approveWorkflowRun').mockRejectedValue(null)

    await expect(approvePendingRuns(octokit, new utils.MockContext(prCommentEvent('/ok-to-test')), 1, headSha))
      .rejects
      .toThrow('could not approve run 8 (CI): null')
  })
})

describe('okToTestOnPullRequest', () => {
  beforeEach(() => setup(''))

  function pullEvent(action: string, labels: unknown) {
    const event = structuredClone(prOpenedEvent) as { action: string, pull_request?: { labels: unknown } }
    event.action = action
    event.pull_request!.labels = labels
    return event
  }

  const labeled = [{ name: 'ok-to-test' }]

  // `action !== 'synchronize' && action !== 'reopened'`: a labeled pull request
  // on any other action is left alone
  it.each(['opened', 'labeled', 'closed', 'edited'])('makes no Actions call on %s even when labeled', async (action) => {
    server.use(http.get(`${repo}/actions/runs`, utils.mockResponse(200, { total_count: 0, workflow_runs: [] })))

    await expect(okToTestOnPullRequest(new utils.MockContext(pullEvent(action, labeled) as never))).resolves.toBeUndefined()

    expect(calls).toEqual([])
  })

  // `pull?.labels`: a payload without a pull request returns quietly
  it('a synchronize payload without a pull request returns quietly', async () => {
    const event = pullEvent('synchronize', labeled)
    delete event.pull_request
    const debug = vi.spyOn(core, 'debug')

    await expect(okToTestOnPullRequest(new utils.MockContext(event as never))).resolves.toBeUndefined()

    expect(debug).toHaveBeenCalledWith('trigger: the pull request does not carry ok-to-test')
    expect(calls).toEqual([])
  })

  // `pull?.head?.sha`: a labeled pull request without a head object fails with
  // the payload in the message, not a bare TypeError from `.sha`
  it('a labeled pull request without a head object throws the missing-head error', async () => {
    const event = pullEvent('synchronize', labeled) as { pull_request?: { head?: unknown } }
    delete event.pull_request!.head

    await expect(okToTestOnPullRequest(new utils.MockContext(event as never))).rejects.toThrow('github context payload missing pull request head')
    expect(calls).toEqual([])
  })

  // `label?.name`: a null entry in the labels array is skipped, not dereferenced
  it('skips a null label entry and still finds ok-to-test', async () => {
    const approved: number[] = []
    server.use(
      serveRuns([{ id: 8, name: 'CI', status: 'action_required', conclusion: 'action_required' }]),
      recordRerun(approved, 'approve'),
    )

    await expect(okToTestOnPullRequest(new utils.MockContext(pullEvent('synchronize', [null, { name: 'ok-to-test' }]) as never))).resolves.toBeUndefined()

    expect(approved).toEqual([8])
  })

  // `core.getInput('github-token', { required: true })` fails fast
  it('fails before any request when the github-token input is missing', async () => {
    delete process.env['INPUT_GITHUB-TOKEN']

    await expect(okToTestOnPullRequest(new utils.MockContext(pullEvent('synchronize', labeled) as never))).rejects.toThrow('Input required and not supplied: github-token')
    expect(calls).toEqual([])
  })
})
