import type { FakeGithub } from './fakeGithub'
import { Buffer } from 'node:buffer'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import labelFileContents from '../fixtures/labels/labelFileContentsResp.json'
import { start } from './fakeGithub'
import { repo, token } from './helpers'
import { runBundle } from './runBundle'

vi.setConfig({ testTimeout: 30_000 })

// the arms of the label-sync job that bundle.test.ts never reaches: a refused write is recorded and
// the remaining labels are still attempted, the run fails once naming every failure, and a label whose
// only drift is its description is patched with the description alone
describe('dist/index.js workflow_dispatch label-sync job failure arms', () => {
  let gh: FakeGithub

  beforeAll(async () => {
    gh = await start()
  })
  afterEach(() => gh.reset())
  afterAll(() => gh.close())

  const orgConfig = { ...structuredClone(labelFileContents), content: Buffer.from('labels:\n  kind:\n    - name: bug\n      description: Something is not working\n').toString('base64') }

  const builtins = ['approved', 'do-not-merge/hold', 'good first issue', 'help wanted', 'hold', 'lgtm', 'lifecycle/frozen', 'lifecycle/rotten', 'lifecycle/stale', 'ok-to-test', 'stage/alpha', 'stage/beta', 'stage/stable', 'status/approved-for-milestone', 'status/in-progress', 'status/in-review']

  it('refused creates are each recorded, the description-only drift is still patched, and the run fails once naming every refused label', async () => {
    gh.route('GET', '/repos/Codertocat/.project/contents/prow.yaml', { status: 200, body: orgConfig })
    gh.route('GET', `${repo}/labels`, {
      status: 200,
      body: [{ name: 'kind/bug', color: '000000', description: 'stale text' }],
    })
    gh.route('POST', `${repo}/labels`, { status: 403, body: { message: 'Resource not accessible by integration' } })
    gh.route('PATCH', `${repo}/labels/kind%2Fbug`, { status: 200, body: {} })

    const result = await runBundle({
      eventName: 'workflow_dispatch',
      payload: {},
      inputs: { ...token, jobs: 'label-sync' },
      apiUrl: gh.url,
    })

    expect(result.status, result.stdout).toBe(1)
    // one core.error per refused label, then the single failure that ends the run
    const perLabel = builtins.map(name => `label-sync: could not sync ${name}: Resource not accessible by integration`)
    expect(result.errors.slice(0, builtins.length)).toEqual(perLabel)
    expect(result.errors).toHaveLength(builtins.length + 1)
    expect(result.errors[builtins.length]).toContain(`TypeError: error handling cron job: Error: ${builtins.length} label(s) could not be synced: ${builtins.map(name => `${name} (Resource not accessible by integration`).join('), ')}`)
    expect(result.stdout).toContain(`label-sync: created 0 [], updated 1 [kind/bug], unchanged 0, failed ${builtins.length}`)

    // every create is still attempted after the first refusal
    const posts = gh.requestsMatching('POST', /\/labels$/)
    expect(posts.map(p => (p.body as { name: string }).name)).toEqual(builtins)
    const patches = gh.requestsMatching('PATCH', /./)
    expect(patches).toHaveLength(1)
    expect(patches[0].path).toBe(`${repo}/labels/kind%2Fbug`)
    expect(patches[0].body).toEqual({ description: 'Something is not working' })
  })
})
