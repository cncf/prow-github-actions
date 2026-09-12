import { Buffer } from 'node:buffer'
import * as core from '@actions/core'
import { http } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { handleCronJobs } from '../../src/cronJobs/handleCronJob'
import { labelSync } from '../../src/cronJobs/labelSync'
import labelFileContents from '../fixtures/labels/labelFileContentsResp.json'
import listPullReqs from '../fixtures/pullReq/pullReqListPulls.json'
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

interface RepoLabel {
  name: string
  color: string
  description?: string | null
}

interface Write {
  method: string
  name?: string
  body: unknown
}

const prowYaml = `
labels:
  kind:
    - name: bug
      color: d73a4a
      description: Something is not working
    - cleanup
  labels:
    - documentation
`

// everything desiredLabels yields for prowYaml, as the repository would hold it
const complete: RepoLabel[] = [
  { name: 'approved', color: '0ffa16', description: 'Indicates a PR has been approved by an approver from all required OWNERS files.' },
  { name: 'documentation', color: 'aaaaaa', description: 'kept as is' },
  { name: 'good first issue', color: '7057ff', description: 'Denotes an issue ready for a new contributor, according to the "help wanted" guidelines.' },
  { name: 'help wanted', color: '006b75', description: 'Denotes an issue that needs help from a contributor. Must meet "help wanted" guidelines.' },
  { name: 'hold', color: 'e11d21', description: 'Indicates that a PR should not merge because someone has issued a /hold command.' },
  { name: 'kind/bug', color: 'd73a4a', description: 'Something is not working' },
  { name: 'kind/cleanup', color: 'bbbbbb', description: null },
  { name: 'lgtm', color: '15dd18', description: '"Looks good to me", indicates that a PR is ready to be merged.' },
  { name: 'lifecycle/frozen', color: 'd3e2f0', description: 'Indicates that an issue or PR should not be auto-closed due to staleness.' },
  { name: 'lifecycle/rotten', color: '604460', description: 'Denotes an issue or PR that has aged beyond stale and will be auto-closed.' },
  { name: 'lifecycle/stale', color: '795548', description: 'Denotes an issue or PR has remained open with no activity and has become stale.' },
  { name: 'stage/alpha', color: 'cccccc' },
  { name: 'stage/beta', color: 'cccccc' },
  { name: 'stage/stable', color: 'cccccc' },
  { name: 'status/approved-for-milestone', color: 'cccccc' },
  { name: 'status/in-progress', color: 'cccccc' },
  { name: 'status/in-review', color: 'cccccc' },
]

function withChanges(...changes: RepoLabel[]): RepoLabel[] {
  return complete.map(label => changes.find(change => change.name === label.name) ?? label)
}

function dispatchContext() {
  return new utils.MockContext({ repository: { owner: { login: 'Codertocat' }, name: 'Hello-World' } })
}

function serveConfig(text = prowYaml) {
  const file = structuredClone(labelFileContents)
  file.content = Buffer.from(text).toString('base64')
  server.use(
    http.get(`${repo}/contents/.github%2Fprow.yaml`, utils.mockResponse(200, file)),
    ...utils.noOrgOrRepoConfigExcept('.github/prow.yaml'),
  )
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...headers } })
}

function recordWrites(existing: RepoLabel[], createStatus: (name: string) => number = () => 201): Write[] {
  const writes: Write[] = []
  server.use(
    utils.repoHasLabels(existing),
    http.post(`${repo}/labels`, async ({ request }) => {
      const body = await request.json() as { name: string }
      writes.push({ method: 'POST', body })
      const status = createStatus(body.name)
      return json(status === 201 ? body : { message: 'Validation Failed' }, status)
    }),
    http.patch(`${repo}/labels/:name`, async ({ request, params }) => {
      writes.push({ method: 'PATCH', name: decodeURIComponent(params.name as string), body: await request.json() })
      return json({})
    }),
    http.delete(`${repo}/labels/:name`, ({ params }) => {
      writes.push({ method: 'DELETE', name: decodeURIComponent(params.name as string), body: undefined })
      return new Response(null, { status: 204 })
    }),
  )
  return writes
}

describe('label-sync job', () => {
  beforeEach(() => {
    utils.setupJobsEnv('label-sync')
  })

  it('creates every missing label with only the fields that are known', async () => {
    serveConfig()
    const writes = recordWrites([])
    const info = vi.spyOn(core, 'info').mockImplementation(() => {})

    const result = await labelSync(dispatchContext())

    expect(writes.every(w => w.method === 'POST')).toBe(true)
    expect(writes.map(w => (w.body as { name: string }).name)).toEqual(complete.map(l => l.name))
    expect(writes.find(w => (w.body as { name: string }).name === 'kind/bug')!.body).toEqual({
      name: 'kind/bug',
      color: 'd73a4a',
      description: 'Something is not working',
    })
    expect(writes.find(w => (w.body as { name: string }).name === 'kind/cleanup')!.body).toEqual({ name: 'kind/cleanup' })
    expect(writes.find(w => (w.body as { name: string }).name === 'lgtm')!.body).toMatchObject({ name: 'lgtm', color: '15dd18' })
    expect(result).toEqual({ created: complete.map(l => l.name), updated: [], unchanged: 0, failures: [] })
    expect(info).toHaveBeenCalledWith(expect.stringContaining(`created ${complete.length}`))
  })

  it('updates a label whose color differs and sends only that field', async () => {
    serveConfig()
    const writes = recordWrites(withChanges({ name: 'lgtm', color: '000000', description: complete.find(l => l.name === 'lgtm')!.description }))

    const result = await labelSync(dispatchContext())

    expect(writes).toEqual([{ method: 'PATCH', name: 'lgtm', body: { color: '15dd18' } }])
    expect(result.updated).toEqual(['lgtm'])
    expect(result.created).toEqual([])
    expect(result.unchanged).toBe(complete.length - 1)
  })

  it('updates a label whose description differs', async () => {
    serveConfig()
    const writes = recordWrites(withChanges({ name: 'kind/bug', color: 'd73a4a', description: null }))

    await labelSync(dispatchContext())

    expect(writes).toEqual([{ method: 'PATCH', name: 'kind/bug', body: { description: 'Something is not working' } }])
  })

  it('writes nothing when only the case of the name or color differs, or when the repo has extra metadata', async () => {
    serveConfig()
    const observePatch = new utils.ObserveRequest()
    server.use(http.patch(`${repo}/labels/:name`, utils.mockResponse(200, {}, observePatch)))
    const writes = recordWrites(withChanges(
      { name: 'Kind/Bug', color: 'D73A4A', description: 'Something is not working' },
      { name: 'LGTM', color: '15DD18', description: complete.find(l => l.name === 'lgtm')!.description },
      { name: 'kind/cleanup', color: 'bbbbbb', description: 'a description the config does not know' },
    ))

    const result = await labelSync(dispatchContext())

    expect(writes).toEqual([])
    await expect(observePatch.notCalled()).resolves.toBe('not called')
    expect(result).toEqual({ created: [], updated: [], unchanged: complete.length, failures: [] })
  })

  it('never deletes a label the configuration does not mention', async () => {
    serveConfig()
    const observeDelete = new utils.ObserveRequest()
    server.use(http.delete(`${repo}/labels/:name`, utils.mockResponse(204, null, observeDelete)))
    const writes = recordWrites([...complete, { name: 'obsolete', color: 'ffffff' }, { name: 'kind/legacy', color: 'ffffff' }])

    await labelSync(dispatchContext())

    expect(writes.filter(w => w.method === 'DELETE')).toEqual([])
    expect(writes).toEqual([])
    await expect(observeDelete.notCalled()).resolves.toBe('not called')
  })

  it('reads every page of the repository labels', async () => {
    serveConfig()
    const writes = recordWrites([])
    const half = Math.ceil(complete.length / 2)
    const pages = new Set<string | null>()
    server.use(
      http.get(`${repo}/labels`, ({ request }) => {
        const url = new URL(request.url)
        const page = url.searchParams.get('page')
        pages.add(page)
        if (page === null || page === '1') {
          return json(complete.slice(0, half), 200, { Link: `<${repo}/labels?per_page=100&page=2>; rel="next"` })
        }
        return json(complete.slice(half))
      }),
    )

    const result = await labelSync(dispatchContext())

    expect([...pages]).toEqual([null, '2'])
    expect(writes).toEqual([])
    expect(result.unchanged).toBe(complete.length)
  })

  it('keeps creating after one create fails and then fails the run naming the label', async () => {
    serveConfig()
    const writes = recordWrites([], name => (name === 'kind/bug' ? 422 : 201))
    const logError = vi.spyOn(core, 'error').mockImplementation(() => {})
    const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})

    await expect(handleCronJobs(dispatchContext())).resolves.toBeUndefined()

    expect(writes.map(w => (w.body as { name: string }).name)).toEqual(complete.map(l => l.name))
    expect(logError).toHaveBeenCalledWith(expect.stringContaining('kind/bug'))
    expect(setFailed).toHaveBeenCalledTimes(1)
    expect(setFailed).toHaveBeenCalledWith(expect.stringContaining('kind/bug'))
    expect(setFailed).toHaveBeenCalledWith(expect.stringContaining('1 label(s) could not be synced'))
  })

  it('dry-run logs what would change and writes nothing', async () => {
    process.env['INPUT_DRY-RUN'] = 'true'
    serveConfig()
    const writes = recordWrites(withChanges({ name: 'lgtm', color: '000000' }).filter(l => l.name !== 'kind/bug'))
    const info = vi.spyOn(core, 'info').mockImplementation(() => {})
    const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})

    await handleCronJobs(dispatchContext())

    expect(writes).toEqual([])
    expect(setFailed).not.toHaveBeenCalled()
    const lines = info.mock.calls.map(([line]) => String(line))
    expect(lines.some(line => line.includes('would create') && line.includes('kind/bug'))).toBe(true)
    expect(lines.some(line => line.includes('would update') && line.includes('lgtm'))).toBe(true)
  })

  it('fails the run when the configuration cannot be loaded', async () => {
    server.use(
      http.get(`${repo}/contents/.github%2Fprow.yaml`, utils.mockResponse(500, { message: 'boom' })),
      ...utils.noOrgOrRepoConfigExcept('.github/prow.yaml'),
    )
    const writes = recordWrites([])
    const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})

    await handleCronJobs(dispatchContext())

    expect(writes).toEqual([])
    expect(setFailed).toHaveBeenCalledWith(expect.stringContaining('could not load prow config'))
  })

  it('runs next to an unknown job, which still fails the run', async () => {
    utils.setupJobsEnv('label-sync bogus')
    serveConfig()
    const writes = recordWrites(complete)
    const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})

    await handleCronJobs(dispatchContext())

    expect(writes).toEqual([])
    expect(setFailed).toHaveBeenCalledWith(expect.stringContaining('could not execute bogus'))
  })

  it('jobs: lgtm label-sync runs both jobs', async () => {
    utils.setupJobsEnv('lgtm label-sync')
    serveConfig()
    const writes = recordWrites(complete.filter(l => l.name !== 'documentation'))
    const mergeReq = new utils.ObserveRequest()
    server.use(
      http.get(`${repo}/pulls`, ({ request }) => {
        const page = new URL(request.url).searchParams.get('page')
        const payload = structuredClone(listPullReqs)
        payload[0].labels[0].name = 'lgtm'
        return json(page === '1' ? payload : [])
      }),
      http.put(`${repo}/pulls/2/merge`, utils.mockResponse(200, null, mergeReq)),
    )
    const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})

    await handleCronJobs(dispatchContext())

    await expect(mergeReq.called()).resolves.toBe('called')
    expect(writes).toEqual([{ method: 'POST', body: { name: 'documentation' } }])
    expect(setFailed).not.toHaveBeenCalled()
  })
})
