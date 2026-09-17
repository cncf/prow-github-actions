import { Buffer } from 'node:buffer'
import * as core from '@actions/core'
import { http } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { handleCronJobs } from '../../src/cronJobs/handleCronJob'
import { sweep, sweepConcurrency } from '../../src/cronJobs/sweep'
import { maxSweepLookbackMs, parseProwConfig, resolveSweepLookback } from '../../src/utils/config'
import labelFileContents from '../fixtures/labels/labelFileContentsResp.json'
import pullReqOpenedEvent from '../fixtures/pullReq/pullReqOpenedEvent.json'
import * as utils from '../testUtils'
import { blobSha } from '../utils/ownersFixtures'

const server = setupServer()
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

const repo = `${utils.api}/repos/Codertocat/Hello-World`
const now = new Date('2026-09-16T12:00:00Z')
const hour = 3_600_000

function ago(ms: number): string {
  return new Date(now.getTime() - ms).toISOString()
}

interface PullSpec {
  number: number
  updated?: string
  created?: string
  labels?: string[]
  draft?: boolean
  requested_reviewers?: string[]
  head?: string
  mergeable_state?: string
  user?: string
}

function pull(spec: PullSpec) {
  return {
    number: spec.number,
    state: 'open',
    locked: false,
    draft: spec.draft ?? false,
    merged: false,
    mergeable: true,
    mergeable_state: spec.mergeable_state ?? 'clean',
    labels: (spec.labels ?? []).map(name => ({ name })),
    created_at: spec.created ?? spec.updated ?? ago(10 * 60_000),
    updated_at: spec.updated ?? ago(10 * 60_000),
    requested_reviewers: (spec.requested_reviewers ?? []).map(login => ({ login })),
    assignees: [],
    user: { login: spec.user ?? 'some-author' },
    head: { sha: spec.head ?? `sha${spec.number}` },
    base: { sha: 'basesha' },
  }
}

// serves the open pull requests newest-updated first, `pageSize` per page, and each one by number
function servePulls(specs: PullSpec[], pageSize = 100) {
  const items = specs.map(pull).sort((a, b) => b.updated_at.localeCompare(a.updated_at))
  const listCalls: string[] = []
  server.use(
    http.get(`${repo}/pulls`, ({ request }) => {
      const url = new URL(request.url)
      listCalls.push(url.search)
      const page = Number(url.searchParams.get('page') ?? '1')
      return new Response(JSON.stringify(items.slice((page - 1) * pageSize, page * pageSize)), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }),
    http.get(`${repo}/pulls/:number`, ({ params }) => {
      const item = items.find(pr => pr.number === Number(params.number))
      return new Response(JSON.stringify(item ?? { message: 'Not Found' }), { status: item ? 200 : 404, headers: { 'Content-Type': 'application/json' } })
    }),
  )
  return listCalls
}

function prowYaml(text: string) {
  const file = structuredClone(labelFileContents)
  file.content = Buffer.from(text).toString('base64')
  return http.get(utils.contentsUrl('.github/prow.yaml'), utils.mockResponse(200, file))
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

let context: utils.MockContext

beforeEach(() => {
  utils.setupJobsEnv('sweep')
  vi.useFakeTimers({ now, toFake: ['Date'] })
  context = new utils.MockContext(pullReqOpenedEvent)
  server.use(...utils.noOrgOrRepoConfigExcept(), utils.defaultBranchTree(), utils.lgtmStatus())
})

afterEach(() => {
  vi.useRealTimers()
})

describe('resolveSweepLookback', () => {
  it('defaults to 1h, honours the configuration and caps at 24h', () => {
    expect(resolveSweepLookback({})).toBe(hour)
    expect(resolveSweepLookback({ lookback: '30m' })).toBe(30 * 60_000)
    expect(resolveSweepLookback({ lookback: '48h' })).toBe(maxSweepLookbackMs)
  })

  it.each([
    ['a non-mapping', 'sweep: 1h\n', 'x: sweep must be a mapping'],
    ['a non-string lookback', 'sweep:\n  lookback: 3600\n', 'x: sweep.lookback must be a duration string such as 1h or 30m'],
    ['a malformed lookback', 'sweep:\n  lookback: soon\n', 'x: invalid sweep.lookback \'soon\': expected a duration such as 5s, 2m or 500ms'],
    ['a zero lookback', 'sweep:\n  lookback: \'0\'\n', 'x: sweep.lookback must be longer than 0'],
  ])('rejects %s', (_, text, error) => {
    expect(() => parseProwConfig('x', text)).toThrow(error)
  })

  it('accepts a lookback and marks the document as the new form on its own', () => {
    expect(parseProwConfig('x', 'sweep:\n  lookback: 2h\n')).toEqual({ sweep: { lookback: '2h' } })
  })
})

describe('sweep candidates', () => {
  it('evaluates the pull requests updated within the lookback and no other', async () => {
    const reads: number[] = []
    servePulls([
      { number: 1, updated: ago(5 * 60_000) },
      { number: 2, updated: ago(2 * hour) },
      { number: 3, updated: ago(59 * 60_000) },
    ])
    server.use(http.get(`${repo}/pulls/:number`, ({ params }) => {
      reads.push(Number(params.number))
      return json(pull({ number: Number(params.number) }))
    }))
    const info = vi.spyOn(core, 'info')

    await expect(sweep(context)).resolves.toMatchObject({ candidates: [1, 3], merged: [], failures: [] })
    expect(reads.sort()).toEqual([1, 3])
    expect(info).toHaveBeenCalledWith(`sweep: 2 candidates updated since ${ago(hour)}`)
    expect(info).toHaveBeenCalledWith('skipping pr #1: missing lgtm')
  })

  it('lists newest first and stops at the first full page that reaches back past the window', async () => {
    const specs = Array.from({ length: 100 }, (_, i) => ({ number: i + 1, updated: ago(i < 98 ? 1_000 * (i + 1) : 2 * hour + 1_000 * i) }))
    const listCalls = servePulls(specs)

    const result = await sweep(context)
    expect(result.candidates).toHaveLength(98)
    expect(result.candidates).not.toContain(99)
    expect(listCalls).toEqual(['?state=open&sort=updated&direction=desc&per_page=100&page=1'])
  })

  it('keeps paging while a full page is still inside the window', async () => {
    let pages = 0
    const items = Array.from({ length: 100 }, (_, i) => pull({ number: i + 1, updated: ago(1_000 * (i + 1)) }))
    server.use(
      http.get(`${repo}/pulls`, ({ request }) => {
        pages++
        const page = Number(new URL(request.url).searchParams.get('page'))
        return json(page === 1 ? items : [])
      }),
      http.get(`${repo}/pulls/:number`, ({ params }) => json(pull({ number: Number(params.number) }))),
    )

    const result = await sweep(context)
    expect(result.candidates).toHaveLength(100)
    expect(pages).toBe(2)
  })

  it('honours sweep.lookback', async () => {
    server.use(prowYaml('sweep:\n  lookback: 10m\n'))
    servePulls([{ number: 1, updated: ago(5 * 60_000) }, { number: 2, updated: ago(30 * 60_000) }])

    await expect(sweep(context)).resolves.toMatchObject({ candidates: [1] })
  })

  it('with no candidate makes no further call', async () => {
    servePulls([{ number: 2, updated: ago(2 * hour) }])
    const tree = new utils.ObserveRequest()
    server.use(utils.defaultBranchTree([], tree))

    await expect(sweep(context)).resolves.toEqual({ candidates: [], merged: [], failures: [] })
    await expect(tree.notCalled()).resolves.toBe('not called')
  })

  it('fails when the list cannot be read', async () => {
    server.use(http.get(`${repo}/pulls`, () => json({ message: 'boom' }, 500)))

    await expect(sweep(context)).rejects.toThrow('sweep: could not list the open pull requests')
  })
})

describe('sweep on a repository without OWNERS files', () => {
  it('applies the require_matching_label rules, then the merge path: a bound lgtm on a clean pr merges', async () => {
    server.use(prowYaml('require_matching_label:\n  - regexp: ^kind/\n    missing_label: needs-kind\n    prs: true\n'))
    servePulls([{ number: 1, labels: ['lgtm', 'kind/bug'] }])
    const merge = new utils.ObserveRequest()
    const ownersTree = new utils.ObserveRequest()
    server.use(
      http.get(`${repo}/issues/1`, utils.mockResponse(200, { labels: [{ name: 'lgtm' }, { name: 'kind/bug' }] })),
      http.put(`${repo}/pulls/1/merge`, utils.mockResponse(200, { merged: true }, merge)),
      http.get(`${repo}/git/trees/basesha`, utils.mockResponse(200, { tree: [] }, ownersTree)),
    )
    const info = vi.spyOn(core, 'info')

    await expect(sweep(context)).resolves.toEqual({ candidates: [1], merged: [1], failures: [] })
    await expect(merge.called()).resolves.toBe('called')
    await expect(ownersTree.notCalled()).resolves.toBe('not called')
    expect(info).toHaveBeenCalledWith('sweep: #1 merged')
  })

  it('a stale lgtm is stripped, not merged, and the sweep does not fail', async () => {
    const sha = 'def0123456789abcdef0123456789abcdef01234'
    servePulls([{ number: 1, labels: ['lgtm'], head: sha }])
    const merge = new utils.ObserveRequest()
    const removeLabel = new utils.ObserveRequest()
    server.use(
      utils.lgtmStatus(sha, false),
      http.put(`${repo}/pulls/1/merge`, utils.mockResponse(200, { merged: true }, merge)),
      http.delete(`${repo}/issues/1/labels/lgtm`, utils.mockResponse(200, [], removeLabel)),
      http.post(`${repo}/statuses/${sha}`, utils.mockResponse(201, {})),
      http.get(`${repo}/issues/1/comments`, utils.mockResponse(200, [])),
      http.post(`${repo}/issues/1/comments`, utils.mockResponse(201, {})),
    )

    await expect(sweep(context)).resolves.toEqual({ candidates: [1], merged: [], failures: [] })
    await expect(removeLabel.called()).resolves.toBe('called')
    await expect(merge.notCalled()).resolves.toBe('not called')
  })

  it('adds needs-kind to a fresh pull request without a kind label', async () => {
    server.use(prowYaml('require_matching_label:\n  - regexp: ^kind/\n    missing_label: needs-kind\n    prs: true\n'))
    servePulls([{ number: 1 }])
    const add = new utils.ObserveRequest()
    server.use(
      http.get(`${repo}/issues/1`, utils.mockResponse(200, { labels: [] })),
      utils.repoHasLabels(['needs-kind']),
      http.post(`${repo}/issues/1/labels`, utils.mockResponse(200, [], add)),
    )

    await expect(sweep(context)).resolves.toMatchObject({ failures: [] })
    await expect(add.called()).resolves.toBe('called')
    expect(await add.body()).toEqual({ labels: ['needs-kind'] })
  })

  it('merges regardless of tide.merge_on_events: the sweep is a scheduled job, not an event handler', async () => {
    server.use(prowYaml('tide:\n  merge_on_events: false\n'))
    servePulls([{ number: 1, labels: ['lgtm'] }])
    const merge = new utils.ObserveRequest()
    server.use(http.put(`${repo}/pulls/1/merge`, utils.mockResponse(200, { merged: true }, merge)))

    await expect(sweep(context)).resolves.toMatchObject({ merged: [1] })
    await expect(merge.called()).resolves.toBe('called')
  })

  it('one failing pull request does not stop the others; the run fails at the end listing it', async () => {
    servePulls([{ number: 1, labels: ['lgtm'] }, { number: 2, labels: ['lgtm'] }])
    const mergeTwo = new utils.ObserveRequest()
    server.use(
      http.put(`${repo}/pulls/1/merge`, utils.mockResponse(405, { message: 'Pull Request is not mergeable' })),
      http.put(`${repo}/pulls/2/merge`, utils.mockResponse(200, { merged: true }, mergeTwo)),
    )
    vi.spyOn(core, 'error').mockImplementation(() => {})
    const info = vi.spyOn(core, 'info')

    await expect(sweep(context)).rejects.toThrow('sweep: 1 pull request(s) failed: #1 (tide: Pull Request is not mergeable)')
    await expect(mergeTwo.called()).resolves.toBe('called')
    expect(info).toHaveBeenCalledWith('sweep: #1 evaluated with 1 error(s)')
    expect(info).toHaveBeenCalledWith('sweep: #2 merged')
  })

  it('evaluates at most a few pull requests at once', async () => {
    const specs = Array.from({ length: 8 }, (_, i) => ({ number: i + 1, updated: ago(1_000 * (i + 1)) }))
    servePulls(specs)
    let inFlight = 0
    let peak = 0
    server.use(http.get(`${repo}/pulls/:number`, async ({ params }) => {
      inFlight++
      peak = Math.max(peak, inFlight)
      await new Promise(resolve => setTimeout(resolve, 5))
      inFlight--
      return json(pull({ number: Number(params.number) }))
    }))

    await expect(sweep(context)).resolves.toMatchObject({ failures: [] })
    expect(peak).toBeLessThanOrEqual(sweepConcurrency)
    expect(peak).toBeGreaterThan(1)
  })
})

describe('sweep on a repository with OWNERS files', () => {
  const owners = {
    'OWNERS': 'approvers:\n- alice\nreviewers:\n- carol\n',
    'sdk/OWNERS': 'reviewers:\n- bob\nlabels:\n- area/sdk\n',
  }

  function serveOwners(files: string[]) {
    const tree = Object.keys(owners).map(path => ({ path, type: 'blob', sha: blobSha(path) }))
    server.use(
      utils.defaultBranchTree(Object.keys(owners)),
      http.get(`${repo}/git/trees/basesha`, utils.mockResponse(200, { sha: 'basesha', truncated: false, tree })),
      http.get(`${repo}/pulls/:number/files`, utils.mockResponse(200, files.map(filename => ({ filename, status: 'modified' })))),
      ...Object.entries(owners).map(([path, contents]) => http.get(`${repo}/git/blobs/${blobSha(path)}`, utils.mockResponse(200, { encoding: 'base64', content: Buffer.from(contents).toString('base64') }))),
      http.get(`${repo}/issues/:number/comments`, utils.mockResponse(200, [])),
      http.post(`${repo}/issues/:number/comments`, utils.mockResponse(201, {})),
      utils.repoHasLabels(['area/sdk', 'approved', 'lgtm', 'needs-kind']),
    )
  }

  it('a new fork pull request gets the OWNERS labels, reviewers and the approval notifier, then the gate misses approved', async () => {
    serveOwners(['sdk/x.go'])
    servePulls([{ number: 1, created: ago(60_000), updated: ago(60_000), labels: ['lgtm'], user: 'dave' }])
    const labels = new utils.ObserveRequest()
    const reviewers = new utils.ObserveRequest()
    const notifier = new utils.ObserveRequest()
    server.use(
      http.get(`${repo}/issues/1`, utils.mockResponse(200, { labels: [{ name: 'lgtm' }] })),
      http.post(`${repo}/issues/1/labels`, utils.mockResponse(200, [], labels)),
      http.get(`${repo}/pulls/1/reviews`, utils.mockResponse(200, [])),
      http.post(`${repo}/pulls/1/requested_reviewers`, utils.mockResponse(201, {}, reviewers)),
      http.post(`${repo}/issues/1/comments`, utils.mockResponse(201, {}, notifier)),
    )
    const info = vi.spyOn(core, 'info')

    await expect(sweep(context)).resolves.toEqual({ candidates: [1], merged: [], failures: [] })
    await expect(labels.called()).resolves.toBe('called')
    expect(await labels.body()).toEqual({ labels: ['area/sdk'] })
    await expect(reviewers.called()).resolves.toBe('called')
    const picked = (await reviewers.body()).reviewers as string[]
    expect(picked).toHaveLength(2)
    expect(['alice', 'bob', 'carol']).toEqual(expect.arrayContaining(picked))
    await expect(notifier.called()).resolves.toBe('called')
    expect((await notifier.body()).body).toContain('[APPROVALNOTIFIER] This PR is **NOT APPROVED**')
    expect(info).toHaveBeenCalledWith('skipping pr #1: missing approved')
  })

  it('an old pull request, or one with requested reviewers, reviews or a draft, gets no reviewers', async () => {
    serveOwners(['sdk/x.go'])
    servePulls([
      { number: 1, created: ago(3 * hour), updated: ago(60_000) },
      { number: 2, created: ago(60_000), updated: ago(60_000), requested_reviewers: ['bob'] },
      { number: 3, created: ago(60_000), updated: ago(60_000), draft: true },
      { number: 4, created: ago(60_000), updated: ago(60_000) },
    ])
    const reviewers = new utils.ObserveRequest()
    const reviewReads: number[] = []
    server.use(
      http.get(`${repo}/issues/:number`, utils.mockResponse(200, { labels: [{ name: 'area/sdk' }] })),
      http.get(`${repo}/pulls/:number/reviews`, ({ params }) => {
        reviewReads.push(Number(params.number))
        return json([{ id: 1, state: 'COMMENTED', user: { login: 'bob' } }])
      }),
      http.post(`${repo}/pulls/:number/requested_reviewers`, utils.mockResponse(201, {}, reviewers)),
    )

    await expect(sweep(context)).resolves.toMatchObject({ failures: [] })
    await expect(reviewers.notCalled()).resolves.toBe('not called')
    // only #4 passed the cheap gates and needed the reviews read; approve reads reviews for every pr too
    expect(reviewReads.filter((n, i) => reviewReads.indexOf(n) !== i)).toEqual([4])
  })

  it('a bound lgtm and approved on a clean pull request merges', async () => {
    serveOwners(['sdk/x.go'])
    servePulls([{ number: 1, created: ago(3 * hour), labels: ['lgtm', 'approved', 'area/sdk'], user: 'alice' }])
    const merge = new utils.ObserveRequest()
    server.use(
      http.get(`${repo}/issues/1`, utils.mockResponse(200, { labels: [{ name: 'lgtm' }, { name: 'approved' }, { name: 'area/sdk' }] })),
      http.get(`${repo}/pulls/1/reviews`, utils.mockResponse(200, [])),
      http.put(`${repo}/pulls/1/merge`, utils.mockResponse(200, { merged: true }, merge)),
    )

    await expect(sweep(context)).resolves.toEqual({ candidates: [1], merged: [1], failures: [] })
    await expect(merge.called()).resolves.toBe('called')
  })

  it('a failing plugin is recorded with its name and the later steps still run', async () => {
    serveOwners(['sdk/x.go'])
    servePulls([{ number: 1, created: ago(3 * hour), labels: ['lgtm', 'approved'], user: 'alice' }])
    const merge = new utils.ObserveRequest()
    server.use(
      http.get(`${repo}/issues/1`, utils.mockResponse(200, { labels: [{ name: 'lgtm' }, { name: 'approved' }] })),
      http.post(`${repo}/issues/1/labels`, utils.mockResponse(500, { message: 'boom' })),
      http.get(`${repo}/pulls/1/reviews`, utils.mockResponse(200, [])),
      http.put(`${repo}/pulls/1/merge`, utils.mockResponse(200, { merged: true }, merge)),
    )

    await expect(sweep(context)).rejects.toThrow(/sweep: 1 pull request\(s\) failed: #1 \(owners-label: could not add labels/)
    await expect(merge.called()).resolves.toBe('called')
  })
})

describe('handleCronJobs', () => {
  it('jobs: sweep lgtm runs both', async () => {
    servePulls([{ number: 1, labels: ['lgtm'] }])
    server.use(http.get(repo, utils.mockResponse(200, { default_branch: 'master' })))
    let merges = 0
    server.use(http.put(`${repo}/pulls/1/merge`, () => {
      merges++
      return json({ merged: true })
    }))
    utils.setupJobsEnv('sweep lgtm')
    const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})
    const debug = vi.spyOn(core, 'debug')

    await expect(handleCronJobs(context)).resolves.toBeUndefined()

    expect(debug).toHaveBeenCalledWith('running sweep job')
    expect(debug).toHaveBeenCalledWith('running cronLgtm job')
    expect(merges).toBeGreaterThanOrEqual(1)
    expect(setFailed).not.toHaveBeenCalled()
  })

  it('a failing sweep fails the run', async () => {
    server.use(http.get(`${repo}/pulls`, () => json({ message: 'boom' }, 500)))
    const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})

    await expect(handleCronJobs(context)).resolves.toBeUndefined()

    expect(setFailed).toHaveBeenCalledExactlyOnceWith(expect.stringContaining('sweep: could not list the open pull requests'))
  })
})
