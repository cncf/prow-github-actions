import type { FakeGithub } from './fakeGithub'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import pullReqListPulls from '../fixtures/pullReq/pullReqListPulls.json'
import pullReqOpenedEvent from '../fixtures/pullReq/pullReqOpenedEvent.json'
import { blobSha, prCommentEvent } from '../utils/ownersFixtures'
import { start } from './fakeGithub'
import { configReads, helpersFor, ownersProbe, queueRead, repo, token } from './helpers'
import { runBundle } from './runBundle'

vi.setConfig({ testTimeout: 30_000 })

// the arms of src/utils/pullRequestOwners.ts (a renamed file, a base tip that cannot be read) and of tide's
// fork-workflows 403 diagnosis (an unreadable diff, no workflow files, a comment already posted or refused)
// that bundle.test.ts never reaches, driven through dist/index.js like the cases there
describe('dist/index.js pull request owners and fork-workflows arms', () => {
  let gh: FakeGithub
  const { expectRequests, routeOwners } = helpersFor(() => gh)

  beforeAll(async () => {
    gh = await start()
  })
  beforeEach(() => gh.mergeQueueFallback({ pullRequestId: 'PR_none', headOid: pullReqOpenedEvent.pull_request.head.sha, enabled: false }))
  afterEach(() => gh.reset())
  afterAll(() => gh.close())

  describe('issue_comment /approve on a pull request', () => {
    const ownersFiles: Record<string, string> = {
      'OWNERS': 'approvers:\n- alice\n',
      'sdk/OWNERS': 'approvers:\n- bob\n',
      'olm/OWNERS': 'options:\n  no_parent_owners: true\napprovers:\n- carol\n',
    }

    // the approve evaluation re-reads the pull request's comments to find `commenter`'s /approve
    function routeWrites(commenter: string) {
      gh.route('GET', `${repo}/issues/1/comments`, { status: 200, body: [{ id: 1, body: '/approve', user: { login: commenter, type: 'User' }, created_at: '2024-01-01T00:00:01Z' }] })
      gh.route('GET', `${repo}/pulls/1/reviews`, { status: 200, body: [] })
      gh.route('GET', `${repo}/labels`, { status: 200, body: [{ name: 'approved' }, { name: 'lgtm' }] })
      gh.route('POST', `${repo}/issues/1/labels`, { status: 200, body: [] })
      gh.route('POST', `${repo}/issues/1/comments`, { status: 201, body: {} })
    }

    function runApprove(commenter: string) {
      return runBundle({
        eventName: 'issue_comment',
        payload: prCommentEvent('/approve', commenter),
        inputs: { ...token, 'prow-commands': '/approve' },
        apiUrl: gh.url,
      })
    }

    it('a renamed file needs approval under its previous name too: bob owns the new path, carol the old one', async () => {
      gh.route('GET', `${repo}/pulls/1/files`, {
        status: 200,
        body: [{ filename: 'sdk/moved.go', previous_filename: 'olm/moved.go', status: 'renamed' }],
      })
      routeOwners(ownersFiles, [], { user: { login: 'some-author' } })
      routeWrites('bob')

      const result = await runApprove('bob')

      expect(result.status, result.stdout).toBe(0)
      expect(result.errors).toEqual([])
      expect(result.stdout).not.toContain('is approved by')
      expect(gh.requestsMatching('POST', /\/issues\/1\/labels$/)).toEqual([])
      const comments = gh.requestsMatching('POST', /\/issues\/1\/comments$/)
      expect(comments).toHaveLength(1)
      const body = (comments[0].body as { body: string }).body
      expect(body).toContain('[APPROVALNOTIFIER] This PR is **NOT APPROVED**')
      // sdk/moved.go is approved by bob; olm/moved.go, the name it had, still needs carol
      expect(body).toContain('~~[sdk/OWNERS](https://github.com/Codertocat/Hello-World/blob/basesha/sdk/OWNERS)~~ [bob]')
      expect(body).toContain('**[olm/OWNERS](https://github.com/Codertocat/Hello-World/blob/basesha/olm/OWNERS)**')
      expect(body).toContain('please assign **carol** after the PR has been reviewed')
      expect(result.stdout).toContain('approve: #1 is not approved; nobody approves olm/moved.go')
    })

    it('when the tip of the base branch cannot be read, OWNERS come from the sha the pull request snapshots, with a warning', async () => {
      gh.route('GET', `${repo}/branches/master`, { status: 500, body: { message: 'Server Error' } })
      gh.route('GET', `${repo}/git/trees/snapshotsha`, {
        status: 200,
        body: {
          sha: 'snapshotsha',
          truncated: false,
          tree: Object.keys(ownersFiles).map(path => ({ path, type: 'blob', sha: blobSha(path) })),
        },
      })
      routeOwners(ownersFiles, ['sdk/x.go'], {
        base: { ref: 'master', sha: 'snapshotsha' },
        user: { login: 'some-author' },
      })
      routeWrites('bob')

      const result = await runApprove('bob')

      expect(result.status, result.stdout).toBe(0)
      expect(result.errors).toEqual([])
      expect(result.stdout).toContain('::warning::could not read the tip of master; reading OWNERS at snapshotsha: ')
      expect(result.stdout).toContain('approve: #1 is approved by bob')
      expect(gh.requestsMatching('POST', /\/issues\/1\/labels$/).map(r => r.body)).toEqual([{ labels: ['approved'] }])
      const comments = gh.requestsMatching('POST', /\/issues\/1\/comments$/)
      expect(comments).toHaveLength(1)
      expect((comments[0].body as { body: string }).body).toContain('~~[sdk/OWNERS](https://github.com/Codertocat/Hello-World/blob/snapshotsha/sdk/OWNERS)~~ [bob]')
      // one failed branch read, then the tree at the snapshot; no retry of the branch
      expect(gh.requestsMatching('GET', /\/branches\/master$/)).toHaveLength(1)
      expect(gh.requestsMatching('GET', /\/git\/trees\/basesha/)).toEqual([])
      expect(gh.requestsMatching('GET', /\/git\/trees\/snapshotsha/)).toHaveLength(1)
    })
  })

  describe('schedule lgtm job: a fork pull request GitHub refuses with 403', () => {
    const gateReads = [`GET ${repo}/pulls?state=open&page=1`, ownersProbe]
    const head = pullReqListPulls[0].head.sha
    const evaluation = [`GET ${repo}/pulls/2`, `GET ${repo}/commits/${head}/status?per_page=100`, queueRead]
    const marker = `<!-- prow-github-actions/fork-workflows: ${head.slice(0, 7)} -->`
    const bot = { login: 'github-actions[bot]', type: 'Bot' }

    function routeForkPr() {
      const pr = {
        ...structuredClone(pullReqListPulls[0]),
        labels: [{ name: 'lgtm' }],
        head: { sha: head, repo: { full_name: 'dave/Hello-World' } },
      }
      gh.route('GET', repo, { status: 200, body: { default_branch: 'master' } })
      gh.route('GET', new RegExp(`^${repo}/pulls\\?`), (req) => {
        const page = new URL(req.path, gh.url).searchParams.get('page')
        return { status: 200, body: page === '1' ? [pr] : [] }
      })
      gh.route('GET', `${repo}/pulls/2`, { status: 200, body: { ...pr, mergeable: true, mergeable_state: 'clean' } })
      gh.commitStatuses(repo, head, [{ context: 'prow/lgtm', state: 'success' }])
      gh.route('PUT', `${repo}/pulls/2/merge`, { status: 403, body: { message: 'Resource not accessible by integration' } })
    }

    function runCron() {
      return runBundle({
        eventName: 'schedule',
        payload: {},
        inputs: { ...token, 'jobs': 'lgtm', 'merge-method': 'squash' },
        apiUrl: gh.url,
      })
    }

    it('with the explaining comment already posted for this head, nothing is posted again', async () => {
      routeForkPr()
      gh.route('GET', `${repo}/compare/${head}...master`, { status: 200, body: { files: [{ filename: '.github/workflows/prow.yml', status: 'added' }] } })
      gh.route('GET', `${repo}/pulls/2/files`, { status: 200, body: [{ filename: 'README.md', status: 'modified' }] })
      gh.route('GET', `${repo}/issues/2/comments`, {
        status: 200,
        body: [
          { id: 901, body: `quoting the bot: ${marker}`, user: { login: 'dave', type: 'User' } },
          { id: 900, body: `GitHub does not let the workflow token merge this pull request\n\n${marker}`, user: bot },
        ],
      })

      const result = await runCron()

      expect(result.status, result.stdout).toBe(0)
      expect(result.errors).toEqual([])
      expect(result.stdout).toContain('skipping pr #2: fork pull request with workflow changes: the token may not merge it')
      expect(gh.requestsMatching('POST', /\/issues\/2\/comments$/)).toEqual([])
      expectRequests(configReads(), [
        ...gateReads,
        ...evaluation,
        `PUT ${repo}/pulls/2/merge`,
        `GET ${repo}/pulls/2`,
        `GET ${repo}/compare/${head}...master`,
        `GET ${repo}/pulls/2/files?per_page=100`,
        `GET ${repo}/issues/2/comments?per_page=100`,
        `GET ${repo}/pulls?state=open&page=2`,
      ])
    })

    it('when the explaining comment is refused, the pull request is still skipped with a warning', async () => {
      routeForkPr()
      gh.route('GET', `${repo}/compare/${head}...master`, { status: 200, body: { files: [] } })
      gh.route('GET', `${repo}/pulls/2/files`, { status: 200, body: [{ filename: '.github/workflows/ci.yml', status: 'modified' }, { filename: 'README.md', status: 'modified' }] })
      gh.route('GET', `${repo}/issues/2/comments`, { status: 200, body: [] })
      gh.route('POST', `${repo}/issues/2/comments`, { status: 500, body: { message: 'Server Error' } })

      const result = await runCron()

      expect(result.status, result.stdout).toBe(0)
      expect(result.errors).toEqual([])
      expect(result.stdout).toContain('::warning::pr #2 is a fork pull request whose merge involves workflow files (`.github/workflows/ci.yml`) that it changes; the token may not merge it')
      expect(result.stdout).toContain('::warning::could not comment on pr #2 about the workflow files: Error: could not add comment: ')
      expect(result.stdout).toContain('skipping pr #2: fork pull request with workflow changes: the token may not merge it')
      expect(gh.requestsMatching('POST', /\/issues\/2\/comments$/)).toHaveLength(1)
    })

    it('when neither the base nor the pull request involves workflow files, the 403 is a plain merge failure', async () => {
      routeForkPr()
      gh.route('GET', `${repo}/compare/${head}...master`, { status: 200, body: { files: [{ filename: 'docs/readme.md', status: 'modified' }] } })
      gh.route('GET', `${repo}/pulls/2/files`, { status: 200, body: [{ filename: 'README.md', status: 'modified' }] })

      const result = await runCron()

      expect(result.status, result.stdout).toBe(1)
      expect(result.errors.some(e => e.includes('could not merge pr #2: Resource not accessible by integration'))).toBe(true)
      expect(result.errors.some(e => e.includes('1 pull request(s) could not be merged: #2 (Resource not accessible by integration)'))).toBe(true)
      expect(result.stdout).not.toContain('fork pull request with workflow changes')
      expect(gh.requestsMatching('GET', /\/issues\/2\/comments/)).toEqual([])
      expect(gh.requestsMatching('POST', /\/issues\/2\/comments$/)).toEqual([])
      expectRequests(configReads(), [
        ...gateReads,
        ...evaluation,
        `PUT ${repo}/pulls/2/merge`,
        `GET ${repo}/pulls/2`,
        `GET ${repo}/compare/${head}...master`,
        `GET ${repo}/pulls/2/files?per_page=100`,
        `GET ${repo}/pulls?state=open&page=2`,
      ])
    })

    it('when the diff against the base cannot be read, the diagnosis is dropped and the 403 is a plain merge failure', async () => {
      routeForkPr()
      gh.route('GET', `${repo}/compare/${head}...master`, { status: 500, body: { message: 'Server Error' } })

      const result = await runCron()

      expect(result.status, result.stdout).toBe(1)
      expect(result.errors.some(e => e.includes('could not merge pr #2: Resource not accessible by integration'))).toBe(true)
      expect(result.stdout).not.toContain('fork pull request with workflow changes')
      expect(gh.requestsMatching('GET', /\/pulls\/2\/files/)).toEqual([])
      expect(gh.requestsMatching('POST', /\/issues\/2\/comments$/)).toEqual([])
      expectRequests(configReads(), [
        ...gateReads,
        ...evaluation,
        `PUT ${repo}/pulls/2/merge`,
        `GET ${repo}/pulls/2`,
        `GET ${repo}/compare/${head}...master`,
        `GET ${repo}/pulls?state=open&page=2`,
      ])
    })
  })
})
