import * as core from '@actions/core'
import { http } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { handleIssueComment } from '../../src/issueComment/handleIssueComment'
import issuePayload from '../fixtures/issues/issue.json'
import issueCommentEvent from '../fixtures/issues/issueCommentEvent.json'

import labelFileContents from '../fixtures/labels/labelFileContentsResp.json'
import * as utils from '../testUtils'

const server = setupServer()
beforeAll(() =>
  server.listen({
    onUnhandledRequest: 'error',
  }),
)
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

const repo = `${utils.api}/repos/Codertocat/Hello-World`

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
    http.get(`${repo}/contents/.prowlabels.yaml`, utils.mockResponse(200, labelFileContents)),

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

describe('dynamic label commands from .prowlabels.yaml keys', () => {
  it('/level adds level/<value> for a mapping-form section', async () => {
    const mutations = serveIssueAndRecordMutations([])

    const setFailed = await run('/level', '/level incubation')

    expect(mutations).toEqual(['POST level/incubation'])
    expect(setFailed).not.toHaveBeenCalled()
  })

  it('/level replaces the existing level label when the yaml marks it exclusive', async () => {
    const mutations = serveIssueAndRecordMutations(['level/sandbox'])

    const setFailed = await run('/level', '/level incubation')

    expect(mutations).toEqual(['DELETE level%2Fsandbox', 'POST level/incubation'])
    expect(setFailed).not.toHaveBeenCalled()
  })

  it('/remove-level removes level/<value>', async () => {
    const mutations = serveIssueAndRecordMutations(['level/incubation'])

    const setFailed = await run('/level', '/remove-level incubation')

    expect(mutations).toEqual(['DELETE level%2Fincubation'])
    expect(setFailed).not.toHaveBeenCalled()
  })

  it('/level fails for a value that is not in the section', async () => {
    const mutations = serveIssueAndRecordMutations([])

    const setFailed = await run('/level', '/level foo')

    expect(mutations).toEqual([])
    expect(setFailed).toHaveBeenCalledWith(
      expect.stringContaining('level: command args missing from body'),
    )
  })

  it('/triage stacks labels for a list-form section', async () => {
    const mutations = serveIssueAndRecordMutations(['triage/accepted'])

    const setFailed = await run('/triage', '/triage needs-information')

    expect(mutations).toEqual(['POST triage/needs-information'])
    expect(setFailed).not.toHaveBeenCalled()
  })

  it('fails with the missing key error for a command without a yaml section', async () => {
    const mutations = serveIssueAndRecordMutations([])

    const setFailed = await run('/nonexistent', '/nonexistent x')

    expect(mutations).toEqual([])
    expect(setFailed).toHaveBeenCalledWith(
      expect.stringContaining(`nonexistent: yaml malformed, expected 'nonexistent' top level key`),
    )
  })

  it('listing only /remove-level also enables /level', async () => {
    const mutations = serveIssueAndRecordMutations([])

    const setFailed = await run('/remove-level', '/level graduation')

    expect(mutations).toEqual(['POST level/graduation'])
    expect(setFailed).not.toHaveBeenCalled()
  })

  it('keeps the unsupported command error for a name that is not a valid key', async () => {
    const mutations = serveIssueAndRecordMutations([])

    const setFailed = await run('/foo_bar', '/foo_bar x')

    expect(mutations).toEqual([])
    expect(setFailed).toHaveBeenCalledWith(
      expect.stringContaining('could not execute /foo_bar'),
    )
  })
})
