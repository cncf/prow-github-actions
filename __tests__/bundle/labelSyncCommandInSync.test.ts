import type { FakeGithub } from './fakeGithub'
import { Buffer } from 'node:buffer'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import labelFileContents from '../fixtures/labels/labelFileContentsResp.json'
import { start } from './fakeGithub'
import { comment, configReads, helpersFor, repo, token } from './helpers'
import { runBundle } from './runBundle'

vi.setConfig({ testTimeout: 60_000 })

const labelsRead = `GET ${repo}/labels?per_page=100`

// the two optional lines of /label-sync's report (issueComment/labelSync.ts:32,35): every other
// bundle scenario starts from a repository missing labels, so the comment always carries a
// `Created:` line. A repository the job already brought into line must be reported as
// "created 0, updated 0" with neither list, and must not be written to at all
describe('dist/index.js /label-sync on a repository already in sync', () => {
  let gh: FakeGithub
  const { expectRequests } = helpersFor(() => gh)

  beforeAll(async () => {
    gh = await start()
  })
  afterEach(() => gh.reset())
  afterAll(() => gh.close())

  const orgConfig = {
    ...structuredClone(labelFileContents),
    content: Buffer.from([
      'labels:',
      '  kind:',
      '    - name: bug',
      '      color: d73a4a',
      '      description: Something is not working',
      '    - cleanup',
      '',
    ].join('\n')).toString('base64'),
  }

  it('reports zero created and updated labels, lists nothing and writes nothing', async () => {
    // seed the repository from what a first sync of an empty one creates, so the test holds no
    // copy of the built-in label catalog that could drift from the bundle's
    gh.route('GET', '/repos/Codertocat/.project/contents/prow.yaml', { status: 200, body: orgConfig })
    gh.route('GET', `${repo}/labels`, { status: 200, body: [] })
    gh.route('POST', `${repo}/labels`, { status: 201, body: {} })

    const seed = await runBundle({
      eventName: 'workflow_dispatch',
      payload: {},
      inputs: { ...token, jobs: 'label-sync' },
      apiUrl: gh.url,
    })
    expect(seed.status, seed.stdout).toBe(0)
    const created = gh.requestsMatching('POST', /\/labels$/).map(p => p.body as { name: string, color?: string, description?: string })
    expect(created.length).toBeGreaterThan(0)
    gh.reset()

    gh.route('GET', `${repo}/collaborators/Codertocat`, { status: 204 })
    gh.route('GET', '/repos/Codertocat/.project/contents/prow.yaml', { status: 200, body: orgConfig })
    gh.route('GET', `${repo}/labels`, {
      status: 200,
      // the api always returns a color; a label created without one gets GitHub's default
      body: created.map(label => ({ name: label.name, color: label.color ?? 'ededed', description: label.description ?? null })),
    })
    gh.route('POST', `${repo}/issues/1/comments`, { status: 201, body: {} })

    const result = await runBundle({
      eventName: 'issue_comment',
      payload: comment('/label-sync', 'some-author'),
      inputs: { ...token, 'prow-commands': '/label-sync' },
      apiUrl: gh.url,
    })

    expect(result.status, result.stdout).toBe(0)
    expect(result.errors).toEqual([])
    expect(result.stdout).toContain(`label-sync: created 0 [], updated 0 [], unchanged ${created.length}, failed 0`)

    const comments = gh.requestsMatching('POST', /\/issues\/1\/comments$/)
    expect(comments).toHaveLength(1)
    expect((comments[0].body as { body: string }).body).toBe(`label-sync: created 0, updated 0, unchanged ${created.length}.`)
    expect(gh.requestsMatching('POST', /\/labels$/)).toEqual([])
    expect(gh.requestsMatching('PATCH', /./)).toEqual([])
    expect(gh.requestsMatching('DELETE', /./)).toEqual([])
    expectRequests(
      [`GET ${repo}/collaborators/Codertocat`, ...configReads({ org: '.project' }), labelsRead],
      [`POST ${repo}/issues/1/comments`],
    )
  })
})
