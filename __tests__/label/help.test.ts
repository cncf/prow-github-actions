import * as core from '@actions/core'
import { http } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { handleIssueComment } from '../../src/issueComment/handleIssueComment'
import issuePayload from '../fixtures/issues/issue.json'
import issueCommentEvent from '../fixtures/issues/issueCommentEvent.json'

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

function serveIssueAndRecordMutations(currentLabels: string[]) {
  const mutations: string[] = []
  const yamlFetch = new utils.ObserveRequest()
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
    http.get(`${repo}/contents/:path`, utils.mockResponse(404, null, yamlFetch)),
  )
  return { mutations, yamlFetch }
}

async function run(config: string, body: string) {
  utils.setupActionsEnv(config)
  issueCommentEvent.comment.body = body
  const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})
  await handleIssueComment(new utils.MockContext(issueCommentEvent))
  return setFailed
}

describe('/help and /good-first-issue', () => {
  it('/help adds help wanted without reading .prowlabels.yaml', async () => {
    const { mutations, yamlFetch } = serveIssueAndRecordMutations([])

    const setFailed = await run('/help', '/help')

    expect(mutations).toEqual(['POST help wanted'])
    await expect(yamlFetch.notCalled()).resolves.toBe('not called')
    expect(setFailed).not.toHaveBeenCalled()
  })

  it('/good-first-issue adds good first issue and help wanted in one request', async () => {
    const { mutations, yamlFetch } = serveIssueAndRecordMutations([])

    const setFailed = await run('/good-first-issue', '/good-first-issue')

    expect(mutations).toEqual(['POST good first issue,help wanted'])
    await expect(yamlFetch.notCalled()).resolves.toBe('not called')
    expect(setFailed).not.toHaveBeenCalled()
  })

  it('/remove-help removes both labels when present', async () => {
    const { mutations } = serveIssueAndRecordMutations(['help wanted', 'good first issue'])

    const setFailed = await run('/help', '/remove-help')

    expect(mutations).toEqual(['DELETE help%20wanted', 'DELETE good%20first%20issue'])
    expect(setFailed).not.toHaveBeenCalled()
  })

  it('/remove-good-first-issue removes only good first issue', async () => {
    const { mutations } = serveIssueAndRecordMutations(['help wanted', 'good first issue'])

    const setFailed = await run('/good-first-issue', '/remove-good-first-issue')

    expect(mutations).toEqual(['DELETE good%20first%20issue'])
    expect(setFailed).not.toHaveBeenCalled()
  })

  it('/remove-help removes labels with the casing on the issue', async () => {
    const { mutations } = serveIssueAndRecordMutations(['Help Wanted'])

    const setFailed = await run('/help', '/remove-help')

    expect(mutations).toEqual(['DELETE Help%20Wanted'])
    expect(setFailed).not.toHaveBeenCalled()
  })

  it('/remove-help is a no-op when neither label is on the issue', async () => {
    const { mutations } = serveIssueAndRecordMutations([])

    const setFailed = await run('/help', '/remove-help')

    expect(mutations).toEqual([])
    expect(setFailed).not.toHaveBeenCalled()
  })

  it('listing only /remove-good-first-issue also enables /good-first-issue', async () => {
    const { mutations } = serveIssueAndRecordMutations([])

    const setFailed = await run('/remove-good-first-issue', '/good-first-issue')

    expect(mutations).toEqual(['POST good first issue,help wanted'])
    expect(setFailed).not.toHaveBeenCalled()
  })

  it('/HELP is matched regardless of case', async () => {
    const { mutations } = serveIssueAndRecordMutations([])

    const setFailed = await run('/help', '/HELP')

    expect(mutations).toEqual(['POST help wanted'])
    expect(setFailed).not.toHaveBeenCalled()
  })

  it('fails the action when the issue cannot be read for /remove-help', async () => {
    server.use(
      http.get(`${repo}/issues/1`, utils.mockResponse(500)),
    )

    const setFailed = await run('/help', '/remove-help')

    expect(setFailed).toHaveBeenCalledWith(
      expect.stringContaining('could not get labels from issue'),
    )
  })
})
