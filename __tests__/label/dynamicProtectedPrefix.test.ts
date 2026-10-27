import { Buffer } from 'node:buffer'

import * as core from '@actions/core'
import { http } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { handleIssueComment } from '../../src/issueComment/handleIssueComment'
import issuePayload from '../fixtures/issues/issue.json'
import issueCommentEvent from '../fixtures/issues/issueCommentEvent.json'

import labelFileContents from '../fixtures/labels/labelFileContentsResp.json'
import * as utils from '../testUtils'

// The protected-label refusal ("<label> is managed by its own command") belongs to the bare
// /label and /remove-label commands only (requestedLabels' `cmd.prefix === ''` guard). A
// configured section whose key coincides with a protected prefix — `do-not-merge`, the family
// isProtectedLabel refuses by prefix — still labels through its own /<key> command: the section
// is the maintainers' allowlist for it.

const server = setupServer()
utils.failTestOnUnhandledRequests(server)
beforeAll(() =>
  server.listen(utils.failOnUnhandledRequest),
)
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

const repo = `${utils.api}/repos/Codertocat/Hello-World`

const doNotMergeSection = structuredClone(labelFileContents)
doNotMergeSection.content = Buffer.from(
  'labels:\n  - documentation\n  - do-not-merge/work-in-progress\n\ndo-not-merge:\n  - work-in-progress\n  - invalid-owners-file\n',
).toString('base64')

function issueWithLabels(...names: string[]) {
  const payload = structuredClone(issuePayload)
  for (const name of names) {
    payload.labels.push({ ...payload.labels[0], name })
  }
  return payload
}

function serveIssueAndRecordMutations(currentLabels: string[]): string[] {
  const mutations: string[] = []
  server.use(
    http.delete(`${repo}/issues/1/labels/:name`, async ({ request }) => {
      mutations.push(`DELETE ${new URL(request.url).pathname.split('/labels/')[1]}`)
      return new Response(null, { status: 200 })
    }),
    http.post(`${repo}/issues/1/labels`, async ({ request }) => {
      const body = await request.json() as { labels: string[] }
      mutations.push(`POST ${body.labels.join(',')}`)
      return new Response(null, { status: 200 })
    }),
    http.get(`${repo}/issues/1`, utils.mockResponse(200, issueWithLabels(...currentLabels))),
    http.get(`${repo}/contents/.prowlabels.yaml`, utils.mockResponse(200, doNotMergeSection)),
    utils.repoHasLabels(['do-not-merge/work-in-progress', 'do-not-merge/invalid-owners-file']),

    ...utils.noOrgOrRepoConfigExcept('.prowlabels.yaml'),
  )
  return mutations
}

async function run(config: string, body: string) {
  utils.setupActionsEnv(config)
  issueCommentEvent.comment.body = body
  const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})
  await handleIssueComment(new utils.MockContext(issueCommentEvent))
  return setFailed
}

describe('a do-not-merge label section is labelled by its own command, not refused as protected', () => {
  it('/do-not-merge work-in-progress adds do-not-merge/work-in-progress', async () => {
    const mutations = serveIssueAndRecordMutations([])

    const setFailed = await run('/do-not-merge', '/do-not-merge work-in-progress')

    expect(mutations).toEqual(['POST do-not-merge/work-in-progress'])
    expect(setFailed).not.toHaveBeenCalled()
  })

  it('/remove-do-not-merge work-in-progress removes do-not-merge/work-in-progress', async () => {
    const mutations = serveIssueAndRecordMutations(['do-not-merge/work-in-progress'])

    const setFailed = await run('/do-not-merge', '/remove-do-not-merge work-in-progress')

    expect(mutations).toEqual(['DELETE do-not-merge%2Fwork-in-progress'])
    expect(setFailed).not.toHaveBeenCalled()
  })

  it('/label do-not-merge/work-in-progress stays refused next to the section', async () => {
    const mutations = serveIssueAndRecordMutations([])

    const setFailed = await run('/label', '/label do-not-merge/work-in-progress')

    expect(mutations).toEqual([])
    expect(setFailed).toHaveBeenCalledWith(
      expect.stringContaining('label: do-not-merge/work-in-progress is managed by its own command and cannot be changed with /label'),
    )
  })
})
