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

function yamlFile(text: string) {
  const file = structuredClone(labelFileContents)
  file.content = Buffer.from(text).toString('base64')
  return file
}

function serveIssueAndRecordMutations(currentLabels: string[], yaml = labelFileContents): string[] {
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
    http.get(`${repo}/contents/.prowlabels.yaml`, utils.mockResponse(200, yaml)),

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

describe('built-in lifecycle, stage and status commands', () => {
  it.each([
    ['/lifecycle', 'stale', 'lifecycle/stale'],
    ['/stage', 'beta', 'stage/beta'],
    ['/status', 'in-review', 'status/in-review'],
  ])('%s %s adds %s from the Prow defaults when the yaml has no section', async (command, value, label) => {
    const mutations = serveIssueAndRecordMutations([])

    const setFailed = await run(command, `${command} ${value}`)

    expect(mutations).toEqual([`POST ${label}`])
    expect(setFailed).not.toHaveBeenCalled()
  })

  it('/lifecycle stale replaces the existing lifecycle label', async () => {
    const mutations = serveIssueAndRecordMutations(['lifecycle/rotten'])

    const setFailed = await run('/lifecycle', '/lifecycle stale')

    expect(mutations).toEqual(['DELETE lifecycle%2Frotten', 'POST lifecycle/stale'])
    expect(setFailed).not.toHaveBeenCalled()
  })

  it('/remove-lifecycle stale removes lifecycle/stale', async () => {
    const mutations = serveIssueAndRecordMutations(['lifecycle/stale'])

    const setFailed = await run('/lifecycle', '/remove-lifecycle stale')

    expect(mutations).toEqual(['DELETE lifecycle%2Fstale'])
    expect(setFailed).not.toHaveBeenCalled()
  })

  it('/lifecycle fails for a value outside the defaults', async () => {
    const mutations = serveIssueAndRecordMutations([])

    const setFailed = await run('/lifecycle', '/lifecycle bogus')

    expect(mutations).toEqual([])
    expect(setFailed).toHaveBeenCalledWith(
      expect.stringContaining('lifecycle: command args missing from body'),
    )
  })

  it('/Stage BETA is matched regardless of case and labels stage/beta', async () => {
    const mutations = serveIssueAndRecordMutations([])

    const setFailed = await run('/stage', '/Stage BETA')

    expect(mutations).toEqual(['POST stage/beta'])
    expect(setFailed).not.toHaveBeenCalled()
  })

  it('/lifecycle treats an existing Lifecycle/Rotten as a sibling to replace', async () => {
    const mutations = serveIssueAndRecordMutations(['Lifecycle/Rotten'])

    const setFailed = await run('/lifecycle', '/lifecycle stale')

    expect(mutations).toEqual(['DELETE Lifecycle%2FRotten', 'POST lifecycle/stale'])
    expect(setFailed).not.toHaveBeenCalled()
  })

  describe('with a lifecycle section in the yaml', () => {
    const override = yamlFile('lifecycle:\n  - frozen\n')

    it('the yaml values replace the defaults', async () => {
      const mutations = serveIssueAndRecordMutations([], override)

      const setFailed = await run('/lifecycle', '/lifecycle stale')

      expect(mutations).toEqual([])
      expect(setFailed).toHaveBeenCalledWith(
        expect.stringContaining('lifecycle: command args missing from body'),
      )
    })

    it('a yaml value is applied', async () => {
      const mutations = serveIssueAndRecordMutations([], override)

      const setFailed = await run('/lifecycle', '/lifecycle frozen')

      expect(mutations).toEqual(['POST lifecycle/frozen'])
      expect(setFailed).not.toHaveBeenCalled()
    })

    it('a list-form section keeps the registry exclusive flag', async () => {
      const mutations = serveIssueAndRecordMutations(['lifecycle/stale'], override)

      const setFailed = await run('/lifecycle', '/lifecycle frozen')

      expect(mutations).toEqual(['DELETE lifecycle%2Fstale', 'POST lifecycle/frozen'])
      expect(setFailed).not.toHaveBeenCalled()
    })

    it('a mapping-form section can turn exclusive off', async () => {
      const stacking = yamlFile('lifecycle:\n  values: [frozen, stale]\n  exclusive: false\n')
      const mutations = serveIssueAndRecordMutations(['lifecycle/stale'], stacking)

      const setFailed = await run('/lifecycle', '/lifecycle frozen')

      expect(mutations).toEqual(['POST lifecycle/frozen'])
      expect(setFailed).not.toHaveBeenCalled()
    })
  })
})
