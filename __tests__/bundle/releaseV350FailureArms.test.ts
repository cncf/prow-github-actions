import type { FakeGithub } from './fakeGithub'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import labelFileContents from '../fixtures/labels/labelFileContentsResp.json'
import pullReqListPulls from '../fixtures/pullReq/pullReqListPulls.json'
import pullReqOpenedEvent from '../fixtures/pullReq/pullReqOpenedEvent.json'
import { start } from './fakeGithub'
import { comment, configReads, helpersFor, repo, token } from './helpers'
import { runBundle } from './runBundle'

vi.setConfig({ testTimeout: 30_000 })

// the src/ arms #638, #639 and #640 added that no bundle scenario drove: the exclusive-family refusal of two
// values (prefixed.ts), plain /remove without an argument (remove.ts), the two milestone write failures
// (milestone.ts), blunderbuss's one-at-a-time retry after GitHub refuses the batch (blunderbuss.ts
// requestEach), and the sweep's setup failure when a base branch's tree cannot be listed (sweep.ts)
describe('dist/index.js failure arms added for v3.5.0', () => {
  let gh: FakeGithub
  const { expectRequests, routeOwners } = helpersFor(() => gh)
  const collaboratorRead = `GET ${repo}/collaborators/Codertocat`

  beforeAll(async () => {
    gh = await start()
  })
  afterEach(() => gh.reset())
  afterAll(() => gh.close())

  function run(body: string, commands: string) {
    return runBundle({ eventName: 'issue_comment', payload: comment(body), inputs: { ...token, 'prow-commands': commands }, apiUrl: gh.url })
  }

  describe('label commands', () => {
    it('/level with two values is refused as exclusive, without reading or writing labels', async () => {
      gh.route('GET', `${repo}/contents/.prowlabels.yaml`, { status: 200, body: labelFileContents })

      const result = await run('/level sandbox incubation', '/level')

      expect(result.status, result.stdout).toBe(1)
      expect(result.errors.some(e => e.includes('level: /level takes one value; got level/sandbox, level/incubation'))).toBe(true)
      expect(gh.requestsMatching('DELETE', /./)).toEqual([])
      expect(gh.requestsMatching('POST', /./)).toEqual([])
      expectRequests(configReads({ repo: '.prowlabels.yaml' }), [])
    })

    it('/remove by a collaborator with no label named fails as missing args without reading the issue', async () => {
      gh.route('GET', `${repo}/collaborators/Codertocat`, { status: 204 })

      const result = await run('/remove', '/remove')

      expect(result.status, result.stdout).toBe(1)
      expect(result.errors.some(e => e.includes('remove: command args missing from body'))).toBe(true)
      expect(gh.requestsMatching('DELETE', /./)).toEqual([])
      expectRequests([collaboratorRead, ...configReads()], [])
    })
  })

  describe('/milestone', () => {
    const milestonesRead = `GET ${repo}/milestones?state=open&per_page=100`
    const issuePatch = `PATCH ${repo}/issues/1`

    it('clear whose issue update fails reports the write failure and fails the run', async () => {
      gh.route('GET', `${repo}/collaborators/Codertocat`, { status: 204 })
      gh.route('PATCH', `${repo}/issues/1`, { status: 500, body: { message: 'boom' } })

      const result = await run('/milestone clear', '/milestone')

      expect(result.status, result.stdout).toBe(1)
      expect(result.errors.some(e => e.includes('could not clear milestone'))).toBe(true)
      expectRequests([collaboratorRead], [issuePatch])
      expect(gh.requestsMatching('PATCH', /\/issues\/1$/)[0].body).toEqual({ milestone: null })
    })

    it('naming an existing milestone whose issue update fails reports the write failure and fails the run', async () => {
      gh.route('GET', `${repo}/collaborators/Codertocat`, { status: 204 })
      gh.route('GET', `${repo}/milestones`, { status: 200, body: [{ number: 3, title: 'v1.0' }] })
      gh.route('PATCH', `${repo}/issues/1`, { status: 500, body: { message: 'boom' } })

      const result = await run('/milestone v1.0', '/milestone')

      expect(result.status, result.stdout).toBe(1)
      expect(result.errors.some(e => e.includes('could not set milestone'))).toBe(true)
      expectRequests([collaboratorRead], [milestonesRead, issuePatch])
      expect(gh.requestsMatching('PATCH', /\/issues\/1$/)[0].body).toEqual({ milestone: 3 })
    })
  })

  describe('blunderbuss when GitHub refuses the batch', () => {
    function requested() {
      return gh.requestsMatching('POST', /\/pulls\/1\/requested_reviewers$/).map(r => (r.body as { reviewers: string[] }).reviewers)
    }

    function openPullRequest() {
      return runBundle({ eventName: 'pull_request', payload: pullReqOpenedEvent, inputs: token, apiUrl: gh.url })
    }

    it('retries each reviewer alone, warns about the one still refused and reports the accepted one', async () => {
      routeOwners({ OWNERS: 'reviewers:\n- bob\n- carol\n' }, ['x.go'])
      gh.route('POST', `${repo}/pulls/1/requested_reviewers`, (req) => {
        const { reviewers } = req.body as { reviewers: string[] }
        if (reviewers.length > 1 || reviewers[0] === 'carol') {
          return { status: 422, body: { message: 'Reviews may only be requested from collaborators.' } }
        }
        return { status: 201, body: {} }
      })

      const result = await openPullRequest()

      expect(result.status, result.stdout).toBe(0)
      expect(result.errors).toEqual([])
      expect(result.stdout).toContain('::warning::blunderbuss: could not request review from carol on #1')
      expect(result.stdout).toContain('blunderbuss: requested review from bob on #1')
      const posts = requested()
      expect(posts).toHaveLength(3)
      expect([...posts[0]].sort()).toEqual(['bob', 'carol'])
      expect(posts.slice(1).map(r => r.join()).sort()).toEqual(['bob', 'carol'])
    })

    it('fails the run naming the refusal when every reviewer is refused alone too', async () => {
      routeOwners({ OWNERS: 'reviewers:\n- bob\n' }, ['x.go'])
      gh.route('POST', `${repo}/pulls/1/requested_reviewers`, { status: 422, body: { message: 'Reviews may only be requested from collaborators.' } })

      const result = await openPullRequest()

      expect(result.status, result.stdout).toBe(1)
      expect(result.stdout).toContain('::warning::blunderbuss: could not request review from bob on #1')
      expect(result.errors.join('\n')).toContain('could not request reviewers')
      expect(requested()).toEqual([['bob'], ['bob']])
    })
  })

  describe('schedule sweep job', () => {
    const listPage = (page: number) => `GET ${repo}/pulls?state=open&sort=updated&direction=desc&per_page=100&page=${page}`

    function freshPr(number: number) {
      const stamp = new Date().toISOString()
      return {
        ...structuredClone(pullReqListPulls[0]),
        number,
        labels: [],
        created_at: stamp,
        updated_at: stamp,
        requested_reviewers: [],
        assignees: [],
        draft: false,
        user: { login: 'dave' },
        head: { sha: `sha${number}`, repo: { full_name: 'dave/Hello-World' } },
        base: { ref: 'master', sha: 'basesha' },
      }
    }

    it('a base branch whose tree cannot be listed fails each of its pull requests at setup, reading nothing else for them', async () => {
      gh.route('GET', new RegExp(`^${repo}/pulls\\?`), (req) => {
        const page = new URL(req.path, gh.url).searchParams.get('page')
        return { status: 200, body: page === '1' ? [freshPr(1), freshPr(2)] : [] }
      })
      gh.route('GET', `${repo}/git/trees/master`, { status: 500, body: { message: 'boom' } })

      const result = await runBundle({ eventName: 'schedule', payload: {}, inputs: { ...token, jobs: 'sweep' }, apiUrl: gh.url })

      expect(result.status, result.stdout).toBe(1)
      expect(result.stdout).toContain('sweep: 2 candidates updated since')
      expect(result.stdout).toContain('sweep: #1 evaluated with 1 error(s)')
      expect(result.stdout).toContain('sweep: #2 evaluated with 1 error(s)')
      const failure = result.errors.find(e => e.includes('sweep: 2 pull request(s) failed'))
      expect(failure).toBeDefined()
      expect(failure).toContain('#1 (setup: error listing the tree of master: HttpError: boom)')
      expect(failure).toContain('#2 (setup: error listing the tree of master: HttpError: boom)')
      // the tree is probed once for the shared base branch; neither pull request is read further
      expectRequests(configReads(), [listPage(1), `GET ${repo}/git/trees/master?recursive=true`])
    })
  })
})
