import type { FakeGithub } from './fakeGithub'
import { Buffer } from 'node:buffer'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import labelFileContents from '../fixtures/labels/labelFileContentsResp.json'
import pullReqOpenedEvent from '../fixtures/pullReq/pullReqOpenedEvent.json'
import { start } from './fakeGithub'
import { comment, helpersFor, repo, token } from './helpers'
import { runBundle } from './runBundle'

vi.setConfig({ testTimeout: 30_000 })

function yamlFile(text: string) {
  const file = structuredClone(labelFileContents)
  file.content = Buffer.from(text).toString('base64')
  return file
}

// blunderbuss's remaining arms driven through dist/index.js: the `ready_for_review` skip when drafts are not
// ignored, `/auto-cc` on a plain issue, a changed file no OWNERS covers, an empty candidate set, the candidates
// who already reviewed, and a refused reviewer request. The bundle suite runs the defaults and `blunderbussSettings.test.ts` the configured options.
describe('dist/index.js blunderbuss arms', () => {
  let gh: FakeGithub
  const { routeOwners } = helpersFor(() => gh)

  beforeAll(async () => {
    gh = await start()
  })
  afterEach(() => gh.reset())
  afterAll(() => gh.close())

  function configure(section: string) {
    gh.route('GET', '/repos/Codertocat/.project/contents/prow.yaml', { status: 200, body: yamlFile(`blunderbuss:\n${section}`) })
  }

  function requested() {
    return gh.requestsMatching('POST', /\/pulls\/1\/requested_reviewers$/)
  }

  it('ready_for_review is skipped when ignore_drafts is false, since opened already ran', async () => {
    configure('  ignore_drafts: false\n')
    routeOwners({ 'sdk/OWNERS': 'reviewers:\n- bob\n' }, ['sdk/x.go'])

    const result = await runBundle({
      eventName: 'pull_request',
      payload: { ...pullReqOpenedEvent, action: 'ready_for_review' },
      inputs: token,
      apiUrl: gh.url,
    })

    expect(result.status, result.stdout).toBe(0)
    expect(result.errors).toEqual([])
    expect(result.stdout).toContain('blunderbuss: skipping ready_for_review action')
    expect(requested()).toEqual([])
  })

  it('/auto-cc on an issue that is not a pull request does nothing', async () => {
    const result = await runBundle({
      eventName: 'issue_comment',
      payload: comment('/auto-cc'),
      inputs: { ...token, 'prow-commands': '/auto-cc' },
      apiUrl: gh.url,
    })

    expect(result.status, result.stdout).toBe(0)
    expect(result.errors).toEqual([])
    expect(result.stdout).toContain('blunderbuss: /auto-cc only applies to pull requests')
    expect(gh.requestsMatching('GET', /\/pulls\/1$/)).toEqual([])
    expect(requested()).toEqual([])
  })

  it('a changed file that no OWNERS file covers adds no candidates', async () => {
    routeOwners({ 'sdk/OWNERS': 'reviewers:\n- bob\n' }, ['sdk/x.go', 'README.md'])
    gh.route('POST', `${repo}/pulls/1/requested_reviewers`, { status: 201, body: {} })

    const result = await runBundle({ eventName: 'pull_request', payload: pullReqOpenedEvent, inputs: token, apiUrl: gh.url })

    expect(result.status, result.stdout).toBe(0)
    expect(result.errors).toEqual([])
    expect(requested().map(r => r.body)).toEqual([{ reviewers: ['bob'] }])
  })

  it('requests nobody when the only reviewer is the author', async () => {
    routeOwners({ OWNERS: 'reviewers:\n- alice\n' }, ['x.go'], { user: { login: 'alice' } })

    const result = await runBundle({ eventName: 'pull_request', payload: pullReqOpenedEvent, inputs: token, apiUrl: gh.url })

    expect(result.status, result.stdout).toBe(0)
    expect(result.errors).toEqual([])
    expect(result.stdout).toContain('blunderbuss: no reviewer candidates for #1')
    expect(requested()).toEqual([])
  })

  // the `reviews` fallback in routeOwners serves nobody; these scenarios serve their own list so the bundle drives
  // reviewedBy's filter (a PENDING review stays a candidate), its login mapping (a review without a user is
  // skipped), the empty-candidates return and the listing failure
  it('skips a candidate who already reviewed, but not one whose review is pending', async () => {
    routeOwners({ OWNERS: 'reviewers:\n- bob\n- carol\n' }, ['x.go'])
    gh.route('GET', `${repo}/pulls/1/reviews`, {
      status: 200,
      body: [
        { id: 1, state: 'APPROVED', user: { login: 'Bob' } },
        { id: 2, state: 'PENDING', user: { login: 'carol' } },
        { id: 3, state: 'COMMENTED', user: null },
      ],
    })
    gh.route('POST', `${repo}/pulls/1/requested_reviewers`, { status: 201, body: {} })

    const result = await runBundle({ eventName: 'pull_request', payload: pullReqOpenedEvent, inputs: token, apiUrl: gh.url })

    expect(result.status, result.stdout).toBe(0)
    expect(result.errors).toEqual([])
    expect(gh.requestsMatching('GET', /\/pulls\/1\/reviews/)).toHaveLength(1)
    expect(requested().map(r => r.body)).toEqual([{ reviewers: ['carol'] }])
  })

  it('requests nobody when every candidate has already reviewed', async () => {
    routeOwners({ OWNERS: 'reviewers:\n- bob\n' }, ['x.go'])
    gh.route('GET', `${repo}/pulls/1/reviews`, { status: 200, body: [{ id: 1, state: 'CHANGES_REQUESTED', user: { login: 'bob' } }] })

    const result = await runBundle({ eventName: 'pull_request', payload: pullReqOpenedEvent, inputs: token, apiUrl: gh.url })

    expect(result.status, result.stdout).toBe(0)
    expect(result.errors).toEqual([])
    expect(result.stdout).toContain('blunderbuss: every reviewer candidate for #1 has already reviewed it')
    expect(requested()).toEqual([])
  })

  it('fails the run when the reviews cannot be listed', async () => {
    routeOwners({ OWNERS: 'reviewers:\n- bob\n' }, ['x.go'])
    gh.route('GET', `${repo}/pulls/1/reviews`, { status: 500, body: { message: 'boom' } })

    const result = await runBundle({ eventName: 'pull_request', payload: pullReqOpenedEvent, inputs: token, apiUrl: gh.url })

    expect(result.status, result.stdout).toBe(1)
    expect(requested()).toEqual([])
    expect(result.errors.join('\n')).toContain('could not list reviews')
  })

  it('fails the run when the reviewer request is refused', async () => {
    routeOwners({ OWNERS: 'reviewers:\n- bob\n' }, ['x.go'])
    gh.route('POST', `${repo}/pulls/1/requested_reviewers`, { status: 500, body: { message: 'boom' } })

    const result = await runBundle({ eventName: 'pull_request', payload: pullReqOpenedEvent, inputs: token, apiUrl: gh.url })

    expect(result.status, result.stdout).toBe(1)
    expect(requested()).toHaveLength(1)
    expect(result.errors.join('\n')).toContain('could not request reviewers')
  })
})
