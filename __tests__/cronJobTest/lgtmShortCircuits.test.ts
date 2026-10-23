import { Buffer } from 'node:buffer'
import { http } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'

import { cronLgtm } from '../../src/cronJobs/lgtm'
import labelFileContents from '../fixtures/labels/labelFileContentsResp.json'
import listPullReqs from '../fixtures/pullReq/pullReqListPulls.json'
import pullReqOpenedEvent from '../fixtures/pullReq/pullReqOpenedEvent.json'
import * as utils from '../testUtils'

// cronLgtm's contracts that no merge request can show: the count it resolves
// to, and that a PR it skips before the shared merge path costs no further
// request. Both are only visible by calling cronLgtm directly and by watching
// the per-PR read that evaluateMerge would otherwise make.

const repo = `${utils.api}/repos/Codertocat/Hello-World`

function prowYaml(text: string) {
  const file = structuredClone(labelFileContents)
  file.content = Buffer.from(text).toString('base64')
  return http.get(utils.contentsUrl('.github/prow.yaml'), utils.mockResponse(200, file))
}

function lgtmPr(number: number, ...extraLabels: string[]) {
  const pr = structuredClone(listPullReqs[0])
  pr.number = number
  pr.labels = ['lgtm', ...extraLabels].map(name => ({ ...pr.labels[0], name }))
  return pr
}

function withoutLgtm(number: number) {
  const pr = lgtmPr(number)
  pr.labels = [{ ...pr.labels[0], name: 'approved' }]
  return pr
}

const server = setupServer(
  ...utils.noOrgOrRepoConfigExcept(),
  utils.defaultBranchTree(),
  utils.lgtmStatus(),
  // no merge queue on the base branch: a merged PR is a direct merge
  utils.mergeQueueGraphql({ enabled: false }).handler,
)
beforeAll(() => server.listen(utils.failOnUnhandledRequest))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

/** serves the listing page by page, an empty page after the last, and each listed PR as clean and mergeable */
function routePages(pages: ReturnType<typeof lgtmPr>[][], listing?: utils.ObserveRequest) {
  const all = pages.flat()
  server.use(
    http.get(`${repo}/pulls`, ({ request }) => {
      if (listing)
        listing.ref = request
      const page = Number(new URL(request.url).searchParams.get('page'))
      return utils.mockResponse(200, pages[page - 1] ?? [])({ request })
    }),
    http.get(`${repo}/pulls/:number`, ({ params }) => {
      const pr = all.find(item => item.number === Number(params.number))
      return pr === undefined
        ? new Response(JSON.stringify({ message: 'Not Found' }), { status: 404, headers: { 'Content-Type': 'application/json' } })
        : new Response(JSON.stringify({ ...pr, mergeable: true, mergeable_state: 'clean' }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }),
  )
}

function acceptMerge(number: number) {
  server.use(http.put(`${repo}/pulls/${number}/merge`, utils.mockResponse(200, { merged: true })))
}

function observeRead(number: number) {
  const read = new utils.ObserveRequest()
  const merge = new utils.ObserveRequest()
  server.use(
    http.get(`${repo}/pulls/${number}`, utils.mockResponse(200, lgtmPr(number), read)),
    http.put(`${repo}/pulls/${number}/merge`, utils.mockResponse(200, null, merge)),
  )
  return { read, merge }
}

describe('cronLgtm', () => {
  it('resolves to the number of pull requests it merged across every page, not the number it saw', async () => {
    utils.setupJobsEnv('lgtm')
    const context = new utils.MockContext(pullReqOpenedEvent)
    routePages([
      [lgtmPr(11), withoutLgtm(12)],
      [lgtmPr(13)],
    ])
    acceptMerge(11)
    acceptMerge(13)

    await expect(cronLgtm(1, context)).resolves.toBe(2)
  })

  it('resolves to zero when every listed pull request is skipped', async () => {
    utils.setupJobsEnv('lgtm')
    const context = new utils.MockContext(pullReqOpenedEvent)
    routePages([[withoutLgtm(14), lgtmPr(15, 'do-not-merge/hold')]])

    await expect(cronLgtm(1, context)).resolves.toBe(0)
  })

  it('carries the count of earlier pages into the pages that follow', async () => {
    utils.setupJobsEnv('lgtm')
    const context = new utils.MockContext(pullReqOpenedEvent)
    routePages([[], [lgtmPr(16)]])
    acceptMerge(16)

    await expect(cronLgtm(2, context, { jobsDone: 3, failures: [] })).resolves.toBe(4)
  })

  it('lists only open pull requests', async () => {
    utils.setupJobsEnv('lgtm')
    const context = new utils.MockContext(pullReqOpenedEvent)
    const listing = new utils.ObserveRequest()
    routePages([], listing)

    await expect(cronLgtm(1, context)).resolves.toBe(0)
    expect(listing.ref).not.toBeNull()
    expect(new URL(listing.ref!.url).searchParams.get('state')).toBe('open')
  })

  it.each([
    ['missing lgtm', withoutLgtm(17)],
    ['blocked by a do-not-merge label', lgtmPr(18, 'do-not-merge/work-in-progress')],
  ])('does not read a pull request that fails the merge gate (%s)', async (_reason, pr) => {
    utils.setupJobsEnv('lgtm')
    const context = new utils.MockContext(pullReqOpenedEvent)
    routePages([[pr]])
    const { read, merge } = observeRead(pr.number)

    await expect(cronLgtm(1, context)).resolves.toBe(0)
    await expect(read.notCalled()).resolves.toBe('not called')
    await expect(merge.notCalled()).resolves.toBe('not called')
  })

  it('does not read a locked pull request even when it passes the merge gate', async () => {
    utils.setupJobsEnv('lgtm')
    const context = new utils.MockContext(pullReqOpenedEvent)
    const locked = lgtmPr(19)
    locked.locked = true
    routePages([[locked]])
    const { read, merge } = observeRead(19)

    await expect(cronLgtm(1, context)).resolves.toBe(0)
    await expect(read.notCalled()).resolves.toBe('not called')
    await expect(merge.notCalled()).resolves.toBe('not called')
  })

  it('honours the merge gate of the prow configuration before reading a pull request', async () => {
    utils.setupJobsEnv('lgtm')
    const context = new utils.MockContext(pullReqOpenedEvent)
    server.use(prowYaml(`
tide:
  labels: [lgtm, approved]
`))
    routePages([[lgtmPr(20)]])
    const { read, merge } = observeRead(20)

    await expect(cronLgtm(1, context)).resolves.toBe(0)
    await expect(read.notCalled()).resolves.toBe('not called')
    await expect(merge.notCalled()).resolves.toBe('not called')
  })

  it('requires the github-token input before listing anything', async () => {
    utils.setupJobsEnv('lgtm')
    delete process.env['INPUT_GITHUB-TOKEN']
    const context = new utils.MockContext(pullReqOpenedEvent)
    const listing = new utils.ObserveRequest()
    routePages([], listing)

    await expect(cronLgtm(1, context)).rejects.toThrow('Input required and not supplied: github-token')
    expect(listing.ref).toBeNull()
  })
})
