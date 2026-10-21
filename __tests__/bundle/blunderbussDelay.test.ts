import type { FakeGithub } from './fakeGithub'
import { Buffer } from 'node:buffer'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import labelFileContents from '../fixtures/labels/labelFileContentsResp.json'
import pullReqListPulls from '../fixtures/pullReq/pullReqListPulls.json'
import pullReqOpenedEvent from '../fixtures/pullReq/pullReqOpenedEvent.json'
import { blobSha } from '../utils/ownersData'
import { start } from './fakeGithub'
import { comment, configReads, helpersFor, repo, token } from './helpers'
import { runBundle } from './runBundle'

vi.setConfig({ testTimeout: 30_000 })

describe('dist/index.js delayed blunderbuss', () => {
  let gh: FakeGithub
  const { routeOwners, expectRequests } = helpersFor(() => gh)
  const owners = { OWNERS: 'reviewers:\n- bob\n' }
  const timelinePath = `${repo}/issues/1/timeline`

  beforeAll(async () => {
    gh = await start()
  })
  afterEach(() => gh.reset())
  afterAll(() => gh.close())

  function configure(section = '  delay: 1h\n') {
    const file = structuredClone(labelFileContents)
    file.content = Buffer.from(`blunderbuss:\n${section}`).toString('base64')
    gh.route('GET', '/repos/Codertocat/.project/contents/prow.yaml', { status: 200, body: file })
  }

  function ago(minutes: number) {
    return new Date(Date.now() - minutes * 60_000).toISOString()
  }

  function pull(overrides: Record<string, unknown> = {}) {
    return {
      ...structuredClone(pullReqListPulls[0]),
      number: 1,
      created_at: ago(70),
      updated_at: ago(70),
      labels: [],
      requested_reviewers: [],
      requested_teams: [],
      assignees: [],
      draft: false,
      user: { login: 'Codertocat' },
      base: { ref: 'master', sha: 'basesha' },
      head: { sha: 'sha1', repo: { full_name: 'Codertocat/Hello-World' } },
      ...overrides,
    }
  }

  function routeSweep(pr = pull(), timeline: unknown[] = [], reviews: unknown[] = [], timelinePageTwo?: unknown[]) {
    gh.route('GET', new RegExp(`^${repo}/pulls\\?`), { status: 200, body: [pr] })
    gh.route('GET', `${repo}/git/trees/master`, {
      status: 200,
      body: { sha: 'master', truncated: false, tree: [{ path: 'OWNERS', type: 'blob', sha: blobSha('OWNERS') }] },
    })
    routeOwners(owners, ['x.go'], pr)
    gh.route('GET', timelinePath, (req) => {
      if (new URL(req.path, 'http://localhost').searchParams.get('page') === '2') {
        return { status: 200, body: timelinePageTwo ?? [] }
      }
      return {
        status: 200,
        body: timeline,
        ...(timelinePageTwo === undefined
          ? {}
          : { headers: { link: `<${gh.url}${timelinePath}?per_page=100&page=2>; rel="next"` } }),
      }
    })
    gh.route('GET', `${repo}/pulls/1/reviews`, { status: 200, body: reviews })
    gh.route('POST', `${repo}/pulls/1/requested_reviewers`, { status: 201, body: {} })
    // Recent candidates still run the other sweep plugins.
    gh.route('GET', `${repo}/issues/1`, { status: 200, body: { labels: [] } })
    gh.route('GET', `${repo}/labels`, { status: 200, body: [{ name: 'approved' }, { name: 'lgtm' }] })
    gh.route('GET', `${repo}/issues/1/comments`, { status: 200, body: [] })
    gh.route('POST', `${repo}/issues/1/comments`, { status: 201, body: {} })
  }

  function runSweep() {
    return runBundle({ eventName: 'schedule', payload: {}, inputs: { ...token, jobs: 'sweep' }, apiUrl: gh.url })
  }

  function requested() {
    return gh.requestsMatching('POST', /\/requested_reviewers$/).map(r => r.body)
  }

  function timelineReads() {
    return gh.requestsMatching('GET', /\/timeline\?/)
  }

  function reviewReads() {
    return gh.requestsMatching('GET', /\/reviews\?per_page=1$/)
  }

  it.each(['opened', 'ready_for_review'])('%s defers reviewer assignment to the scheduled sweep', async (action) => {
    configure()
    routeOwners(owners, ['x.go'])

    const result = await runBundle({
      eventName: 'pull_request',
      payload: { ...pullReqOpenedEvent, action },
      inputs: token,
      apiUrl: gh.url,
    })

    expect(result.status, result.stdout).toBe(0)
    expect(result.errors).toEqual([])
    expect(result.stdout).toContain(`#1 ${action}; blunderbuss.delay is set`)
    expect(requested()).toEqual([])
    expect(timelineReads()).toEqual([])
  })

  it('/auto-cc still immediately requests reviewers on a draft when delay is configured', async () => {
    configure()
    routeOwners(owners, ['x.go'], { draft: true })
    gh.route('POST', `${repo}/pulls/1/requested_reviewers`, { status: 201, body: {} })
    const payload = comment('/auto-cc')
    Object.assign(payload.issue, { pull_request: { url: `${gh.url}${repo}/pulls/1` } })

    const result = await runBundle({
      eventName: 'issue_comment',
      payload,
      inputs: { ...token, 'prow-commands': '/auto-cc' },
      apiUrl: gh.url,
    })

    expect(result.status, result.stdout).toBe(0)
    expect(result.errors).toEqual([])
    expect(requested()).toEqual([{ reviewers: ['bob'] }])
    expect(timelineReads()).toEqual([])
  })

  it('requests reviewers for an untouched due pull outside the normal lookback without running other sweep steps', async () => {
    configure()
    routeSweep()

    const result = await runSweep()

    expect(result.status, result.stdout).toBe(0)
    expect(result.errors).toEqual([])
    expect(result.stdout).toContain('sweep: 0 candidates updated since')
    expect(result.stdout).toContain('sweep: 1 more checked for delayed reviewers')
    expect(requested()).toEqual([{ reviewers: ['bob'] }])
    expect(timelineReads()).toHaveLength(1)
    expect(reviewReads()).toHaveLength(1)
    expect(gh.requests.filter(r => r.method !== 'GET').map(r => r.path)).toEqual([`${repo}/pulls/1/requested_reviewers`])
    expect(gh.requestsMatching('GET', /\/issues\/1\/comments|\/actions\/runs/)).toEqual([])
  })

  it.each([
    ['a draft', { draft: true }, [], 'is a draft', 0],
    ['a manual reviewer', { requested_reviewers: [{ login: 'alice' }] }, [], 'already has requested reviewers', 0],
    ['a manual team', { requested_teams: [{ slug: 'sdk' }] }, [], 'already has requested reviewers', 0],
    ['an existing review', {}, [{ id: 7, user: { login: 'alice' }, state: 'COMMENTED' }], 'already has reviews', 1],
  ])('does not assign a due pull with %s', async (_name, overrides, reviews, message, reads) => {
    configure()
    routeSweep(pull(overrides), [], reviews)

    const result = await runSweep()

    expect(result.status, result.stdout).toBe(0)
    expect(result.errors).toEqual([])
    expect(result.stdout).toContain(`sweep: #1 ${message}`)
    expect(requested()).toEqual([])
    expect(timelineReads()).toHaveLength(reads)
    expect(reviewReads()).toHaveLength(reads)
  })

  it('uses the latest ready_for_review event from a later timeline page', async () => {
    configure()
    routeSweep(
      pull({ created_at: ago(300), updated_at: ago(70) }),
      [{ event: 'ready_for_review', created_at: ago(240) }],
      [],
      [{ event: 'ready_for_review', created_at: ago(70) }],
    )

    const result = await runSweep()

    expect(result.status, result.stdout).toBe(0)
    expect(result.errors).toEqual([])
    expect(timelineReads()).toHaveLength(2)
    expect(reviewReads()).toHaveLength(1)
    expect(requested()).toEqual([{ reviewers: ['bob'] }])
  })

  it.each([
    ['not yet due', 30, 30, 'is not due for reviewers', 0],
    ['opened before the due window', 180, 70, 'outside the due window', 1],
  ])('leaves a pull %s alone', async (_name, created, updated, message, reads) => {
    configure()
    routeSweep(pull({ created_at: ago(created), updated_at: ago(updated) }))

    const result = await runSweep()

    expect(result.status, result.stdout).toBe(0)
    expect(result.errors).toEqual([])
    expect(result.stdout).toContain(message)
    expect(requested()).toEqual([])
    expect(timelineReads()).toHaveLength(reads)
    expect(reviewReads()).toEqual([])
  })

  it.each([
    ['due', 70, true],
    ['recently marked ready again', 10, false],
  ])('uses the latest ready_for_review clock for a former draft that is %s', async (_name, latest, due) => {
    configure()
    routeSweep(pull({ created_at: ago(300), updated_at: ago(latest) }), [
      { event: 'ready_for_review', created_at: ago(latest) },
      { event: 'ready_for_review', created_at: ago(240) },
      { event: 'labeled', created_at: ago(5) },
      { event: 'ready_for_review' },
    ])

    const result = await runSweep()

    expect(result.status, result.stdout).toBe(0)
    expect(result.errors).toEqual([])
    expect(timelineReads()).toHaveLength(1)
    expect(reviewReads()).toHaveLength(due ? 1 : 0)
    expect(requested()).toEqual(due ? [{ reviewers: ['bob'] }] : [])
    if (!due) {
      expect(result.stdout).toContain('outside the due window')
      expect(result.stdout).toContain('sweep: #1 evaluated')
    }
  })

  it('uses creation time and requests on a due draft when ignore_drafts is false', async () => {
    configure('  delay: 1h\n  ignore_drafts: false\n')
    routeSweep(pull({ draft: true }))

    const result = await runSweep()

    expect(result.status, result.stdout).toBe(0)
    expect(result.errors).toEqual([])
    expect(requested()).toEqual([{ reviewers: ['bob'] }])
    expect(timelineReads()).toEqual([])
  })

  it('fails closed when a delayed pull timeline cannot be read', async () => {
    configure()
    gh.route('GET', timelinePath, { status: 403, body: { message: 'timeline denied' } })
    routeSweep()

    const result = await runSweep()

    expect(result.status, result.stdout).toBe(1)
    expect(result.errors.join('\n')).toContain('sweep: 1 pull request(s) failed: #1 (blunderbuss: could not read the timeline: HttpError: timeline denied)')
    expect(timelineReads()).toHaveLength(1)
    expect(reviewReads()).toEqual([])
    expect(requested()).toEqual([])
  })

  it('a second sweep leaves the reviewers the first one requested alone', async () => {
    configure()
    // The pull list reflects every reviewer request the fake has accepted so
    // far, as GitHub's would once the first sweep's request lands.
    gh.route('GET', new RegExp(`^${repo}/pulls\\?`), () => {
      const reviewers = requested().flatMap(body => (body as { reviewers: string[] }).reviewers)
      return { status: 200, body: [pull({ requested_reviewers: reviewers.map(login => ({ login })) })] }
    })
    routeSweep()

    const first = await runSweep()

    expect(first.status, first.stdout).toBe(0)
    expect(first.errors).toEqual([])
    expect(requested()).toEqual([{ reviewers: ['bob'] }])
    expect(reviewReads()).toHaveLength(1)

    const second = await runSweep()

    expect(second.status, second.stdout).toBe(0)
    expect(second.errors).toEqual([])
    expect(second.stdout).toContain('sweep: #1 already has requested reviewers')
    expect(requested()).toEqual([{ reviewers: ['bob'] }])
    expect(reviewReads()).toHaveLength(1)
    expect(timelineReads()).toHaveLength(1)
  })

  it.each([
    ['3600', 'blunderbuss.delay must be a duration string such as 1h or 30m'],
    ['later', 'invalid blunderbuss.delay \'later\': expected a duration such as 5s, 2m or 500ms'],
    ['25h', 'blunderbuss.delay must not be longer than 24h'],
  ])('refuses invalid delay %s before listing or mutating pulls', async (delay, message) => {
    configure(`  delay: ${delay}\n`)

    const result = await runSweep()

    expect(result.status, result.stdout).toBe(1)
    expect(result.errors.join('\n')).toContain(`Codertocat/.project:prow.yaml: ${message}`)
    expectRequests(configReads({ org: '.project' }), [])
  })
})
