import { Buffer } from 'node:buffer'
import * as core from '@actions/core'
import { http } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { handleCronJobs } from '../../src/cronJobs/handleCronJob'
import labelFileContents from '../fixtures/labels/labelFileContentsResp.json'
import listPullReqs from '../fixtures/pullReq/pullReqListPulls.json'

import pullReqOpenedEvent from '../fixtures/pullReq/pullReqOpenedEvent.json'
import * as utils from '../testUtils'

// the cron reads the prow configuration for the tide section; no file exists unless a test serves one
function prowYaml(text: string) {
  const file = structuredClone(labelFileContents)
  file.content = Buffer.from(text).toString('base64')
  return http.get(utils.contentsUrl('.github/prow.yaml'), utils.mockResponse(200, file))
}

// the shared merge path re-reads each gate-passing PR: serve it from the listed items, clean and mergeable
function servePullsByNumber(prs: typeof listPullReqs) {
  return http.get(`${utils.api}/repos/Codertocat/Hello-World/pulls/:number`, ({ params }) => {
    const pr = prs.find(item => item.number === Number(params.number))
    return pr === undefined
      ? new Response(JSON.stringify({ message: 'Not Found' }), { status: 404, headers: { 'Content-Type': 'application/json' } })
      : new Response(JSON.stringify({ ...pr, mergeable: true, mergeable_state: 'clean' }), { status: 200, headers: { 'Content-Type': 'application/json' } })
  })
}

const server = setupServer(
  ...utils.noOrgOrRepoConfigExcept(),
  // the gate's default depends on whether the default branch has OWNERS files; none here unless a test serves a tree
  utils.defaultBranchTree(),
  // every head is bound unless a test says otherwise
  utils.lgtmStatus(),
  servePullsByNumber(listPullReqs),
  // /repos/Codertocat/Hello-World/pulls?state=open&page={1,2}
  http.get(
    `${utils.api}/repos/Codertocat/Hello-World/pulls`,
    ({ request }) => {
      const url = new URL(request.url)
      const page = url.searchParams.get('page')

      if (page === '1') {
        return new Response(JSON.stringify(listPullReqs), {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
          },
        })
      }
      else {
        return new Response(JSON.stringify([]), {
          status: 200,
          headers: {
            'Content-Type': 'application/json',
          },
        })
      }
    },
  ),
)
beforeAll(() =>
  server.listen({
    onUnhandledRequest: 'error',
  }),
)
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

describe('cronLgtm', () => {
  it('merges the PR if the lgtm label is present', async () => {
    utils.setupJobsEnv('lgtm')

    // We can use any context here as "schedule" sends no webhook payload
    // Instead, we use it to gain the repo owner and url
    const context = new utils.MockContext(pullReqOpenedEvent)

    listPullReqs[0].labels[0].name = 'lgtm'

    const observeReq = new utils.ObserveRequest()
    server.use(
      http.put(
        `${utils.api}/repos/Codertocat/Hello-World/pulls/2/merge`,
        utils.mockResponse(200, null, observeReq),
      ),
    )

    await expect(handleCronJobs(context)).resolves.not.toThrow()
    expect(await observeReq.body()).toEqual({
      merge_method: 'merge',
      sha: listPullReqs[0].head.sha,
    })
  })

  it('merges the PR with squash configured', async () => {
    utils.setupJobsEnv('lgtm')
    process.env['INPUT_MERGE-METHOD'] = 'squash'

    // We can use any context here as "schedule" sends no webhook payload
    // Instead, we use it to gain the repo owner and url
    const context = new utils.MockContext(pullReqOpenedEvent)

    listPullReqs[0].labels[0].name = 'lgtm'

    const observeReq = new utils.ObserveRequest()
    server.use(
      http.put(
        `${utils.api}/repos/Codertocat/Hello-World/pulls/2/merge`,
        utils.mockResponse(200, null, observeReq),
      ),
    )

    await expect(handleCronJobs(context)).resolves.not.toThrow()
    expect(await observeReq.body()).toEqual({
      merge_method: 'squash',
      sha: listPullReqs[0].head.sha,
    })
  })

  it('merges the PR with rebase configured', async () => {
    utils.setupJobsEnv('lgtm')
    process.env['INPUT_MERGE-METHOD'] = 'rebase'

    // We can use any context here as "schedule" sends no webhook payload
    // Instead, we use it to gain the repo owner and url
    const context = new utils.MockContext(pullReqOpenedEvent)

    listPullReqs[0].labels[0].name = 'lgtm'

    const observeReq = new utils.ObserveRequest()
    server.use(
      http.put(
        `${utils.api}/repos/Codertocat/Hello-World/pulls/2/merge`,
        utils.mockResponse(200, null, observeReq),
      ),
    )

    await expect(handleCronJobs(context)).resolves.not.toThrow()
    expect(await observeReq.body()).toEqual({
      merge_method: 'rebase',
      sha: listPullReqs[0].head.sha,
    })
  })

  it('wont merge a locked PR even if the lgtm label is present', async () => {
    utils.setupJobsEnv('lgtm')

    const context = new utils.MockContext(pullReqOpenedEvent)

    const lockedPrs = structuredClone(listPullReqs)
    lockedPrs[0].locked = true
    lockedPrs[0].labels[0].name = 'lgtm'

    const observeReq = new utils.ObserveRequest()
    server.use(
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/pulls`,
        ({ request }) => {
          const page = new URL(request.url).searchParams.get('page')
          return utils.mockResponse(200, page === '1' ? lockedPrs : [])({ request })
        },
      ),
      http.put(
        `${utils.api}/repos/Codertocat/Hello-World/pulls/2/merge`,
        utils.mockResponse(200, null, observeReq),
      ),
    )

    await expect(handleCronJobs(context)).resolves.not.toThrow()
    await expect(observeReq.notCalled()).resolves.toBe('not called')
  })

  it('wont merge the PR if the hold label is present', async () => {
    utils.setupJobsEnv('lgtm')

    // We can use any context here as "schedule" sends no webhook payload
    // Instead, we use it to gain the repo owner and url
    const context = new utils.MockContext(pullReqOpenedEvent)

    listPullReqs[0].labels[0].name = 'lgtm'
    listPullReqs[0].labels.push({
      id: 1,
      node_id: '123',
      url: 'https://api.github.com/repos/octocat/Hello-World/labels/hold',
      name: 'hold',
      description: 'looks good to me',
      color: 'f29513',
      default: true,
    })

    const observeReq = new utils.ObserveRequest()
    server.use(
      http.put(
        `${utils.api}/repos/Codertocat/Hello-World/pulls/2/merge`,
        utils.mockResponse(200, null, observeReq),
      ),
    )

    await expect(handleCronJobs(context)).resolves.not.toThrow()
    await expect(observeReq.notCalled()).resolves.toBe('not called')
  })

  function lgtmPr(number: number, ...extraLabels: string[]) {
    const pr = structuredClone(listPullReqs[0])
    pr.number = number
    pr.labels = ['lgtm', ...extraLabels].map(name => ({ ...pr.labels[0], name }))
    return pr
  }

  function routePulls(prs: typeof listPullReqs) {
    server.use(
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/pulls`,
        ({ request }) => {
          const page = new URL(request.url).searchParams.get('page')
          return utils.mockResponse(200, page === '1' ? prs : [])({ request })
        },
      ),
      servePullsByNumber(prs),
    )
  }

  function observeMerge(number: number) {
    const observeReq = new utils.ObserveRequest()
    server.use(
      http.put(
        `${utils.api}/repos/Codertocat/Hello-World/pulls/${number}/merge`,
        utils.mockResponse(200, { merged: true }, observeReq),
      ),
    )
    return observeReq
  }

  describe('merge gate', () => {
    it.each([
      'do-not-merge/work-in-progress',
      'do-not-merge/hold',
      'needs-rebase',
    ])('does not merge a PR carrying %s and logs the reason', async (label) => {
      utils.setupJobsEnv('lgtm')
      const context = new utils.MockContext(pullReqOpenedEvent)
      routePulls([lgtmPr(6, label)])
      const observeReq = observeMerge(6)

      const info = vi.spyOn(core, 'info')
      await expect(handleCronJobs(context)).resolves.not.toThrow()
      await expect(observeReq.notCalled()).resolves.toBe('not called')
      expect(info).toHaveBeenCalledWith(`skipping pr #6: blocked by ${label}`)
    })

    it('does not merge a PR without lgtm and logs the missing label', async () => {
      utils.setupJobsEnv('lgtm')
      const context = new utils.MockContext(pullReqOpenedEvent)
      const pr = lgtmPr(7)
      pr.labels = [{ ...pr.labels[0], name: 'approved' }]
      routePulls([pr])
      const observeReq = observeMerge(7)

      const info = vi.spyOn(core, 'info')
      await expect(handleCronJobs(context)).resolves.not.toThrow()
      await expect(observeReq.notCalled()).resolves.toBe('not called')
      expect(info).toHaveBeenCalledWith('skipping pr #7: missing lgtm')
    })

    it('requires approved as well on a repository with OWNERS files, reading the tree once', async () => {
      utils.setupJobsEnv('lgtm')
      const context = new utils.MockContext(pullReqOpenedEvent)
      let trees = 0
      server.use(http.get(`${utils.api}/repos/Codertocat/Hello-World/git/trees/master`, () => {
        trees++
        return new Response(JSON.stringify({ sha: 'x', truncated: false, tree: [{ path: 'OWNERS', type: 'blob', sha: 'a' }] }), { status: 200, headers: { 'Content-Type': 'application/json' } })
      }))
      routePulls([lgtmPr(15), lgtmPr(16, 'approved')])
      const observeFifteen = observeMerge(15)
      const observeSixteen = observeMerge(16)

      const info = vi.spyOn(core, 'info')
      await expect(handleCronJobs(context)).resolves.not.toThrow()
      await expect(observeFifteen.notCalled()).resolves.toBe('not called')
      await expect(observeSixteen.called()).resolves.toBe('called')
      expect(info).toHaveBeenCalledWith('skipping pr #15: missing approved')
      expect(trees).toBe(1)
    })

    it('a configured tide.labels wins over the OWNERS default without reading the tree', async () => {
      utils.setupJobsEnv('lgtm')
      const context = new utils.MockContext(pullReqOpenedEvent)
      const observeTree = new utils.ObserveRequest()
      server.use(prowYaml('tide:\n  labels: [lgtm]\n'), utils.defaultBranchTree(['OWNERS'], observeTree))
      routePulls([lgtmPr(17)])
      const observeReq = observeMerge(17)

      await expect(handleCronJobs(context)).resolves.not.toThrow()
      await expect(observeReq.called()).resolves.toBe('called')
      await expect(observeTree.notCalled()).resolves.toBe('not called')
    })

    it('requires every label of tide.labels', async () => {
      utils.setupJobsEnv('lgtm')
      const context = new utils.MockContext(pullReqOpenedEvent)
      server.use(prowYaml('tide:\n  labels: [lgtm, approved]\n'))
      routePulls([lgtmPr(8), lgtmPr(9, 'approved')])
      const observeEight = observeMerge(8)
      const observeNine = observeMerge(9)

      const info = vi.spyOn(core, 'info')
      await expect(handleCronJobs(context)).resolves.not.toThrow()
      await expect(observeEight.notCalled()).resolves.toBe('not called')
      await expect(observeNine.called()).resolves.toBe('called')
      expect(info).toHaveBeenCalledWith('skipping pr #8: missing approved')
    })

    it('a configured tide.missing_labels replaces the default list', async () => {
      utils.setupJobsEnv('lgtm')
      const context = new utils.MockContext(pullReqOpenedEvent)
      server.use(prowYaml('tide:\n  missing_labels: [needs-rebase]\n'))
      routePulls([lgtmPr(10, 'hold', 'do-not-merge/hold'), lgtmPr(11, 'needs-rebase')])
      const observeTen = observeMerge(10)
      const observeEleven = observeMerge(11)

      await expect(handleCronJobs(context)).resolves.not.toThrow()
      await expect(observeTen.called()).resolves.toBe('called')
      await expect(observeEleven.notCalled()).resolves.toBe('not called')
    })

    it('tide.merge_method wins over the merge-method input', async () => {
      utils.setupJobsEnv('lgtm')
      process.env['INPUT_MERGE-METHOD'] = 'merge'
      const context = new utils.MockContext(pullReqOpenedEvent)
      server.use(prowYaml('tide:\n  merge_method: squash\n'))
      routePulls([lgtmPr(12)])
      const observeReq = observeMerge(12)

      await expect(handleCronJobs(context)).resolves.not.toThrow()
      await expect(observeReq.called()).resolves.toBe('called')
      expect(await observeReq.body()).toEqual({ merge_method: 'squash', sha: listPullReqs[0].head.sha })
    })

    it('an unknown merge-method input falls back to merge', async () => {
      utils.setupJobsEnv('lgtm')
      process.env['INPUT_MERGE-METHOD'] = 'fast-forward'
      const context = new utils.MockContext(pullReqOpenedEvent)
      routePulls([lgtmPr(13)])
      const observeReq = observeMerge(13)

      await expect(handleCronJobs(context)).resolves.not.toThrow()
      expect(await observeReq.body()).toEqual({ merge_method: 'merge', sha: listPullReqs[0].head.sha })
    })

    it('fails the run when the prow configuration is invalid', async () => {
      utils.setupJobsEnv('lgtm')
      const context = new utils.MockContext(pullReqOpenedEvent)
      server.use(prowYaml('tide:\n  merge_method: fast-forward\n'))
      routePulls([lgtmPr(14)])
      const observeReq = observeMerge(14)

      const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})
      await expect(handleCronJobs(context)).resolves.not.toThrow()
      await expect(observeReq.notCalled()).resolves.toBe('not called')
      expect(setFailed).toHaveBeenCalledWith(expect.stringContaining('tide.merge_method must be one of merge, squash, rebase'))
    })
  })

  it('does not fail the run when the merge succeeds', async () => {
    utils.setupJobsEnv('lgtm')
    const context = new utils.MockContext(pullReqOpenedEvent)
    routePulls([lgtmPr(2)])

    const observeReq = new utils.ObserveRequest()
    server.use(
      http.put(
        `${utils.api}/repos/Codertocat/Hello-World/pulls/2/merge`,
        utils.mockResponse(200, { merged: true }, observeReq),
      ),
    )

    const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})
    const error = vi.spyOn(core, 'error').mockImplementation(() => {})
    await expect(handleCronJobs(context)).resolves.not.toThrow()
    await expect(observeReq.called()).resolves.toBe('called')
    expect(setFailed).not.toHaveBeenCalled()
    expect(error).not.toHaveBeenCalled()
  })

  it('attempts every PR and fails the run listing the merge that failed', async () => {
    utils.setupJobsEnv('lgtm')
    const context = new utils.MockContext(pullReqOpenedEvent)
    routePulls([lgtmPr(3), lgtmPr(4)])

    const observeFirst = new utils.ObserveRequest()
    const observeSecond = new utils.ObserveRequest()
    server.use(
      http.put(
        `${utils.api}/repos/Codertocat/Hello-World/pulls/3/merge`,
        utils.mockResponse(405, { message: 'Pull Request is not mergeable' }, observeFirst),
      ),
      http.put(
        `${utils.api}/repos/Codertocat/Hello-World/pulls/4/merge`,
        utils.mockResponse(200, { merged: true }, observeSecond),
      ),
    )

    const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})
    const error = vi.spyOn(core, 'error').mockImplementation(() => {})
    await expect(handleCronJobs(context)).resolves.not.toThrow()
    await expect(observeFirst.called()).resolves.toBe('called')
    await expect(observeSecond.called()).resolves.toBe('called')

    expect(error).toHaveBeenCalledTimes(1)
    expect(error).toHaveBeenCalledWith(expect.stringContaining('could not merge pr #3'))
    expect(setFailed).toHaveBeenCalledTimes(1)
    expect(setFailed).toHaveBeenCalledWith(expect.stringContaining('1 pull request(s) could not be merged'))
    expect(setFailed).toHaveBeenCalledWith(expect.stringContaining('#3'))
    expect(setFailed).toHaveBeenCalledWith(expect.stringContaining('not mergeable'))
    expect(setFailed).not.toHaveBeenCalledWith(expect.stringContaining('#4'))
  })

  it('a 409 (the head or base moved under the merge) is skipped for the next run, not a failure', async () => {
    utils.setupJobsEnv('lgtm')
    const context = new utils.MockContext(pullReqOpenedEvent)
    routePulls([lgtmPr(5)])

    server.use(
      http.put(
        `${utils.api}/repos/Codertocat/Hello-World/pulls/5/merge`,
        utils.mockResponse(409, { message: 'Base branch was modified. Review and try the merge again.' }),
      ),
    )

    const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})
    const error = vi.spyOn(core, 'error').mockImplementation(() => {})
    const info = vi.spyOn(core, 'info')
    await expect(handleCronJobs(context)).resolves.not.toThrow()
    expect(info).toHaveBeenCalledWith('skipping pr #5: base branch moved')
    expect(error).not.toHaveBeenCalled()
    expect(setFailed).not.toHaveBeenCalled()
  })
})
