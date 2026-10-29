import type { FakeGithub } from './fakeGithub'
import { Buffer } from 'node:buffer'
import path from 'node:path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import labelFileContents from '../fixtures/labels/labelFileContentsResp.json'
import pullReqListPulls from '../fixtures/pullReq/pullReqListPulls.json'
import { blobSha } from '../utils/ownersData'
import { start } from './fakeGithub'
import { repo, token } from './helpers'
import { runBundle } from './runBundle'

vi.setConfig({ testTimeout: 30_000 })

const preload = path.resolve(__dirname, 'nonErrorRejectionPreload.cjs')

// The failure arm of the delayed-reviewers pass (src/cronJobs/sweep.ts, the
// `forEachLimited(delayedOnly, …)` catch): a pull request outside the plain
// window is only ever visited by blunderbuss, and when that visit throws the
// sweep records `blunderbuss: <message>` against that number, keeps going for
// the others, and fails the run at the end naming every failure. The catch
// folds a non-Error with `String(e)`, like the candidate pass does (:132);
// that arm is driven the same way nonErrorRejectionPluginArms.test.ts drives
// the candidate pass, with the preload handing the bundle a string rejection.
describe('dist/index.js delayed blunderbuss failing on one pull request', () => {
  let gh: FakeGithub
  const owners = { OWNERS: 'reviewers:\n- bob\n' }

  beforeAll(async () => {
    gh = await start()
  })
  afterEach(() => gh.reset())
  afterAll(() => gh.close())

  function ago(minutes: number) {
    return new Date(Date.now() - minutes * 60_000).toISOString()
  }

  function pull(number: number, minutesAgo: number) {
    return {
      ...structuredClone(pullReqListPulls[0]),
      number,
      created_at: ago(minutesAgo),
      updated_at: ago(minutesAgo),
      labels: [],
      requested_reviewers: [],
      requested_teams: [],
      assignees: [],
      draft: false,
      user: { login: 'Codertocat' },
      base: { ref: 'master', sha: 'basesha' },
      head: { sha: `sha${number}`, repo: { full_name: 'Codertocat/Hello-World' } },
    }
  }

  // both opened inside the default due window [now − 2h, now − 1h] and outside the plain
  // window [now − 1h, now], so each is delayed-only: the sweep visits them for reviewers and nothing else
  const pulls = [pull(1, 90), pull(2, 100)]

  function serve(config: string, timelineOf2: { status: number, body: unknown }) {
    const file = structuredClone(labelFileContents)
    file.content = Buffer.from(config).toString('base64')
    gh.route('GET', '/repos/Codertocat/.project/contents/prow.yaml', { status: 200, body: file })
    gh.route('GET', new RegExp(`^${repo}/pulls\\?`), { status: 200, body: pulls })
    for (const pr of pulls) {
      gh.route('GET', `${repo}/pulls/${pr.number}`, { status: 200, body: pr })
      gh.route('GET', `${repo}/pulls/${pr.number}/files`, { status: 200, body: [{ filename: 'x.go', status: 'modified' }] })
      gh.route('GET', `${repo}/pulls/${pr.number}/reviews`, { status: 200, body: [] })
      gh.route('POST', `${repo}/pulls/${pr.number}/requested_reviewers`, { status: 201, body: {} })
    }
    gh.route('GET', `${repo}/issues/1/timeline`, { status: 200, body: [] })
    gh.route('GET', `${repo}/issues/2/timeline`, timelineOf2)
    gh.route('GET', `${repo}/branches/master`, { status: 200, body: { name: 'master', commit: { sha: 'basesha' } } })
    const tree = Object.keys(owners).map(path => ({ path, type: 'blob', sha: blobSha(path) }))
    gh.route('GET', `${repo}/git/trees/master`, { status: 200, body: { sha: 'master', truncated: false, tree } })
    gh.route('GET', `${repo}/git/trees/basesha`, { status: 200, body: { sha: 'basesha', truncated: false, tree } })
    for (const [path, contents] of Object.entries(owners)) {
      gh.route('GET', `${repo}/git/blobs/${blobSha(path)}`, { status: 200, body: { encoding: 'base64', content: Buffer.from(contents).toString('base64') } })
    }
    gh.route('GET', `${repo}/labels`, { status: 200, body: [{ name: 'approved' }, { name: 'lgtm' }] })
  }

  function runSweep(env?: Record<string, string>) {
    return runBundle({ eventName: 'schedule', payload: {}, inputs: { ...token, jobs: 'sweep' }, apiUrl: gh.url, env })
  }

  function requested() {
    return gh.requestsMatching('POST', /\/requested_reviewers$/).map(r => r.path).sort()
  }

  it('the timeline read of one delayed pull request failing: the other still gets reviewers and the run fails naming blunderbuss and the number', async () => {
    serve('blunderbuss:\n  delay: 1h\n', { status: 500, body: { message: 'boom' } })

    const result = await runSweep()

    expect(result.status, result.stdout).toBe(1)
    expect(result.stdout).toContain('sweep: 0 candidates updated since')
    expect(result.stdout).toContain('sweep: 2 more checked for delayed reviewers')
    // #1 is unaffected by #2's failure
    expect(requested()).toEqual([`${repo}/pulls/1/requested_reviewers`])
    // the one failure is attributed to blunderbuss on #2 and carries the timeline error
    const failure = result.errors.find(e => e.includes('sweep: 1 pull request(s) failed'))
    expect(failure, result.errors.join('\n')).toContain('#2 (blunderbuss: could not read the timeline: HttpError: boom)')
    expect(result.errors.filter(e => e.includes('failed'))).toHaveLength(1)
  })

  it('the review read of one delayed pull request rejecting with a string: the failure carries the string unwrapped and the other still gets reviewers', async () => {
    serve('blunderbuss:\n  delay: 1h\n', { status: 200, body: [] })
    const reviewsRead = `GET ${repo}/pulls/2/reviews`

    const result = await runSweep({ NODE_OPTIONS: `--require "${preload}"`, NON_ERROR_REJECT: reviewsRead })

    expect(result.status, result.stdout).toBe(1)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toBe(`TypeError: error handling cron job: Error: sweep: 1 pull request(s) failed: #2 (blunderbuss: ${reviewsRead} rejected with a string, not an Error)`)
    expect(result.stdout).not.toContain('[object')
    expect(result.stderr).not.toMatch(/Unhandled|unhandledRejection/)
    expect(requested()).toEqual([`${repo}/pulls/1/requested_reviewers`])
  })

  it('both delayed pull requests healthy: the same routes with a readable timeline request reviewers for both and pass', async () => {
    serve('blunderbuss:\n  delay: 1h\n', { status: 200, body: [] })

    const result = await runSweep()

    expect(result.status, result.stdout).toBe(0)
    expect(result.errors).toEqual([])
    expect(requested()).toEqual([`${repo}/pulls/1/requested_reviewers`, `${repo}/pulls/2/requested_reviewers`])
  })
})
