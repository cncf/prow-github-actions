import type { RequireMatchingLabel } from '../../src/utils/config'
import { Buffer } from 'node:buffer'
import * as core from '@actions/core'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { requireMatchingLabel } from '../../src/plugins/requireMatchingLabel'
import issuesLabeledEvent from '../fixtures/issues/issuesLabeledEvent.json'
import labelFileContents from '../fixtures/labels/labelFileContentsResp.json'
import * as utils from '../testUtils'

const server = setupServer(utils.noMergeQueue)
utils.failTestOnUnhandledRequests(server)
beforeAll(() => server.listen(utils.failOnUnhandledRequest))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

const repo = `${utils.api}/repos/Codertocat/Hello-World`
const project = 'Codertocat/.project:prow.yaml'

const kindRule: RequireMatchingLabel = { regexp: '^kind/', missing_label: 'needs-kind', missing_comment: 'Please add a kind label.' }
const areaRule: RequireMatchingLabel = { regexp: '^area/', missing_label: 'needs-area', missing_comment: 'Please add an area label.' }

function serveRules(rules: RequireMatchingLabel[]) {
  const file = structuredClone(labelFileContents)
  file.content = Buffer.from(`require_matching_label:\n${rules.map(rule => `  - ${JSON.stringify(rule)}`).join('\n')}\n`).toString('base64')
  server.use(
    http.get(utils.contentsUrl(project), utils.mockResponse(200, file)),
    ...utils.noOrgOrRepoConfigExcept(project),
  )
}

function issueEvent(action: string, labels: string[], changed: string) {
  const payload = structuredClone(issuesLabeledEvent)
  payload.action = action
  payload.issue.labels = labels.map(name => ({ ...payload.issue.labels[0], name }))
  payload.label = { ...payload.label, name: changed }
  return payload
}

// serves the issue's labels and records every label and comment write
function serveIssue(labels: string[]) {
  const added: string[][] = []
  const commented: string[] = []
  server.use(
    http.get(`${repo}/issues/1`, utils.mockResponse(200, { labels: labels.map(name => ({ name })) })),
    utils.repoHasLabels(['needs-kind', 'needs-area']),
    http.post(`${repo}/issues/1/labels`, async ({ request }) => {
      added.push(((await request.json()) as { labels: string[] }).labels)
      return HttpResponse.json([])
    }),
    http.get(`${repo}/issues/1/comments`, utils.mockResponse(200, [])),
    http.post(`${repo}/issues/1/comments`, async ({ request }) => {
      commented.push(((await request.json()) as { body: string }).body)
      return HttpResponse.json({}, { status: 201 })
    }),
  )
  return { added, commented }
}

// `labeled` and `unlabeled` both narrow the rules to the changed label; the arm
// for `unlabeled` has no test of its own, so an issue that misses every rule
// pins that removing a kind/* label re-evaluates the kind rule and nothing else.
describe('requireMatchingLabel on an unlabeled event', () => {
  let setFailed: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    utils.setupActionsEnv()
    setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})
    vi.spyOn(core, 'debug').mockImplementation(() => {})
  })

  it('applies only the rule the removed label matched, leaving the other rule untouched', async () => {
    serveRules([kindRule, areaRule])
    const writes = serveIssue([])

    await requireMatchingLabel(new utils.MockContext(issueEvent('unlabeled', [], 'kind/bug')))

    expect(writes.added).toEqual([['needs-kind']])
    expect(writes.commented).toHaveLength(1)
    expect(writes.commented[0]).toContain('Please add a kind label.')
    expect(setFailed).not.toHaveBeenCalled()
  })

  it('labeled narrows the same way: adding area/docs satisfies the area rule and never evaluates the kind rule', async () => {
    serveRules([kindRule, areaRule])
    const writes = serveIssue(['area/docs'])

    await requireMatchingLabel(new utils.MockContext(issueEvent('labeled', ['area/docs'], 'area/docs')))

    expect(writes.added).toEqual([])
    expect(writes.commented).toEqual([])
    expect(setFailed).not.toHaveBeenCalled()
  })
})
