import { Buffer } from 'node:buffer'
import * as core from '@actions/core'
import { http } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { blunderbuss } from '../../src/plugins/blunderbuss'
import labelFileContents from '../fixtures/labels/labelFileContentsResp.json'
import pullReqOpenedEvent from '../fixtures/pullReq/pullReqOpenedEvent.json'
import * as utils from '../testUtils'
import { baseSha, changedFiles, filesHandler, repo, treeHandlers } from '../utils/ownersFixtures'

const server = setupServer()
utils.failTestOnUnhandledRequests(server)
beforeAll(() => server.listen(utils.failOnUnhandledRequest))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

const project = 'Codertocat/.project:prow.yaml'

// alice and rita own the whole tree; bob, carol and dave only sdk/
const owners = {
  'OWNERS': 'approvers:\n- alice\nreviewers:\n- rita\n',
  'sdk/OWNERS': 'approvers:\n- bob\nreviewers:\n- carol\n- dave\n',
}

// an rng that always returns 0 picks the first remaining element at every step
const first = () => 0

function prEvent(action: string) {
  return new utils.MockContext({ ...structuredClone(pullReqOpenedEvent), action })
}

function serveConfig(yaml: string) {
  const file = structuredClone(labelFileContents)
  file.content = Buffer.from(yaml).toString('base64')
  server.use(
    http.get(utils.contentsUrl(project), utils.mockResponse(200, file)),
    ...utils.noOrgOrRepoConfigExcept(project),
  )
}

function servePr(files: string[]) {
  server.use(
    http.get(`${repo}/pulls/1`, utils.mockResponse(200, {
      base: { ref: 'master', sha: baseSha },
      head: { sha: 'headsha' },
      user: { login: 'some-author' },
      draft: false,
      requested_reviewers: [],
      assignees: [],
    })),
    filesHandler(changedFiles(...files)),
    ...treeHandlers(owners),
  )
}

// The per-reviewer file count is accumulated with `(coverage.get(login) ?? 0) + 1`;
// a wrong seed (undefined + 1 = NaN) collapses every candidate into one tier, so
// the owner covering more of the changed files loses the preference the plugin
// documents. The existing "weights candidates" case cannot see this: with
// request_count 1 and the last-picking rng both tier layouts yield rita.
describe('blunderbuss prefers the owners covering more of the changed files', () => {
  let setFailed: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    utils.setupActionsEnv()
    setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})
    vi.spyOn(core, 'debug').mockImplementation(() => {})
  })

  it('fills request_count from the two-file tier before any one-file owner is drawn', async () => {
    serveConfig('blunderbuss:\n  request_count: 2\n')
    servePr(['sdk/x.go', 'docs/y.md'])
    const observe = new utils.ObserveRequest()
    server.use(http.post(`${repo}/pulls/1/requested_reviewers`, utils.mockResponse(201, {}, observe)))

    await blunderbuss(prEvent('opened'), first)

    await observe.called()
    const body = await observe.body() as { reviewers: string[] }
    // alice and rita cover both files and fill the count together; were every
    // candidate in one tier, the first-picking rng would draw alice and bob
    expect([...body.reviewers].sort()).toEqual(['alice', 'rita'])
    expect(setFailed).not.toHaveBeenCalled()
  })

  it('draws from the one-file tier only once the two-file tier is exhausted', async () => {
    serveConfig('blunderbuss:\n  request_count: 3\n')
    servePr(['sdk/x.go', 'docs/y.md'])
    const observe = new utils.ObserveRequest()
    server.use(http.post(`${repo}/pulls/1/requested_reviewers`, utils.mockResponse(201, {}, observe)))

    await blunderbuss(prEvent('opened'), first)

    await observe.called()
    const body = await observe.body() as { reviewers: string[] }
    expect([...body.reviewers].sort()).toEqual(['alice', 'bob', 'rita'])
    expect(setFailed).not.toHaveBeenCalled()
  })
})
