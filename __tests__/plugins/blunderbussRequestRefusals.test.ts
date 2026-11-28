import * as core from '@actions/core'
import { Octokit } from '@octokit/rest'
import { http } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { blunderbuss, blunderbussSettings } from '../../src/plugins/blunderbuss'
import { mergeProwConfig } from '../../src/utils/config'
import * as octokitFactory from '../../src/utils/octokit'
import pullReqOpenedEvent from '../fixtures/pullReq/pullReqOpenedEvent.json'
import * as utils from '../testUtils'
import { baseSha, changedFiles, filesHandler, repo, treeHandlers } from '../utils/ownersFixtures'

vi.mock('../../src/utils/octokit', { spy: true })

const server = setupServer()
utils.failTestOnUnhandledRequests(server)
beforeAll(() => server.listen(utils.failOnUnhandledRequest))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

// alice and bob are the two candidates for a change under sdk/ (rita and the
// sdk/ reviewers tie with them, and the first-picking rng takes the two sorted first)
const owners = {
  'OWNERS': 'approvers:\n- alice\nreviewers:\n- rita\n',
  'sdk/OWNERS': 'approvers:\n- bob\nreviewers:\n- carol\n- dave\n',
}

// an rng that always returns 0 picks the first remaining element at every step
const first = () => 0

function prEvent(action: string) {
  return new utils.MockContext({ ...structuredClone(pullReqOpenedEvent), action })
}

function servePr(files: string[]) {
  server.use(
    ...utils.noOrgOrRepoConfigExcept(),
    http.get(`${repo}/pulls/1`, utils.mockResponse(200, {
      base: { ref: 'master', sha: baseSha },
      head: { sha: 'headsha' },
      user: { login: 'some-author' },
      draft: false,
      requested_reviewers: [],
      assignees: [],
    })),
    http.get(`${repo}/pulls/1/reviews`, utils.mockResponse(200, [])),
    filesHandler(changedFiles(...files)),
    ...treeHandlers(owners),
  )
}

/**
 * hands blunderbuss an Octokit whose requestReviewers rejects with `value`
 * instead of an HttpError, the way a network failure or a non-Error throw from
 * a plugin or hook surfaces; everything else still goes through msw
 */
function refuseRequestReviewersWith(value: unknown): ReturnType<typeof vi.fn> {
  const refused = vi.fn().mockRejectedValue(value)
  vi.mocked(octokitFactory.newOctokitFromInputs).mockImplementationOnce(() => {
    const real = new Octokit({ auth: 'some-token', baseUrl: utils.api })
    const pulls = Object.create(real.pulls, { requestReviewers: { value: refused } })
    return Object.create(real, { pulls: { value: pulls } })
  })
  return refused
}

// isUnprocessable reads `'status' in error`, which throws a TypeError on a
// primitive or null; the guard in front of it is what keeps a non-HttpError
// rejection reported by its own string form, and without the per-reviewer
// retry that only a 422 earns.
describe('blunderbuss when the review request rejects with something other than an HttpError', () => {
  let warning: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    utils.setupActionsEnv()
    vi.spyOn(core, 'setFailed').mockImplementation(() => {})
    vi.spyOn(core, 'debug').mockImplementation(() => {})
    warning = vi.spyOn(core, 'warning').mockImplementation(() => {})
  })

  it.each([
    ['a string', 'offline', 'could not request reviewers: offline'],
    ['null', null, 'could not request reviewers: null'],
    ['an Error without a status', new Error('socket hang up'), 'could not request reviewers: Error: socket hang up'],
  ])('%s rejection fails with its string form, not a TypeError, and is not retried one reviewer at a time', async (_, value, message) => {
    servePr(['sdk/x.go'])
    const refused = refuseRequestReviewersWith(value)

    await expect(blunderbuss(prEvent('opened'), first)).rejects.toThrow(message)

    expect(refused).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ pull_number: 1, reviewers: ['alice', 'bob'] }))
    expect(warning).not.toHaveBeenCalled()
  })
})

describe('blunderbuss reports the reviewers it requested', () => {
  beforeEach(() => {
    utils.setupActionsEnv()
    vi.spyOn(core, 'setFailed').mockImplementation(() => {})
    vi.spyOn(core, 'debug').mockImplementation(() => {})
  })

  it('names every requested reviewer, comma separated, in the info line', async () => {
    servePr(['sdk/x.go'])
    const observe = new utils.ObserveRequest()
    server.use(http.post(`${repo}/pulls/1/requested_reviewers`, utils.mockResponse(201, {}, observe)))
    const info = vi.spyOn(core, 'info').mockImplementation(() => {})

    await blunderbuss(prEvent('opened'), first)

    await observe.called()
    expect(info).toHaveBeenCalledWith('blunderbuss: requested review from alice, bob on #1')
  })
})

describe('blunderbussSettings', () => {
  it('names blunderbuss.delay when the configured delay is not a duration', () => {
    expect(() => blunderbussSettings({ ...mergeProwConfig({}, {}), blunderbuss: { delay: 'soon' }, sources: [] }))
      .toThrow('invalid blunderbuss.delay \'soon\': expected a duration such as 5s, 2m or 500ms')
  })
})
