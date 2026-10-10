import type { FakeGithub } from './fakeGithub'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { prCommentEvent } from '../utils/ownersData'
import { start } from './fakeGithub'
import { helpersFor, repo, token } from './helpers'
import { runBundle } from './runBundle'

vi.setConfig({ testTimeout: 30_000 })

// The content shapes parseOwners (src/utils/owners.ts) accepts or rejects, driven through dist/index.js with
// `/approve` on a pull request whose base has a single root OWNERS file, like ownersFilters.test.ts:
// an empty file and a non-mapping document are OWNERS files that list nobody, so the commenter is refused;
// a role that is not a list of strings fails the run naming the file and the role.
describe('dist/index.js OWNERS content shapes', () => {
  let gh: FakeGithub
  const { routeOwners } = helpersFor(() => gh)

  beforeAll(async () => {
    gh = await start()
  })
  afterEach(() => gh.reset())
  afterAll(() => gh.close())

  function routeApprove(owners: string) {
    routeOwners({ OWNERS: owners }, ['src/file1.txt'])
    gh.route('GET', `${repo}/issues/1/comments`, { status: 200, body: [] })
    gh.route('GET', `${repo}/pulls/1/reviews`, { status: 200, body: [] })
    gh.route('GET', `${repo}/labels`, { status: 200, body: [{ name: 'approved' }, { name: 'lgtm' }] })
    gh.route('POST', `${repo}/issues/1/labels`, { status: 200, body: [] })
    gh.route('POST', `${repo}/issues/1/comments`, { status: 201, body: {} })
  }

  function runApprove(commenter = 'alice') {
    return runBundle({
      eventName: 'issue_comment',
      payload: prCommentEvent('/approve', commenter),
      inputs: { ...token, 'prow-commands': '/approve' },
      apiUrl: gh.url,
    })
  }

  // a 0-byte file is left out: decode (owners.ts:163) rejects a blob whose content is '' before parseOwners
  // sees it, which #404 tracks
  it.each([
    ['a whitespace-only file', '  \n\n'],
    ['a yaml list', '- alice\n- bob\n'],
    ['a yaml scalar', 'alice\n'],
  ])('%s is an OWNERS file that names nobody: the commenter is refused, told so, and no label is applied', async (_name, contents) => {
    routeApprove(contents)

    const result = await runApprove()

    const cause = 'alice is not an approver for any changed file'
    const refusal = `Cannot approve the pull request: Error: ${cause}`
    expect(result.status, result.stdout).toBe(1)
    expect(result.errors).toEqual([refusal, `TypeError: error handling issue comment: Error: ${cause}`])
    expect(gh.requestsMatching('POST', /\/issues\/1\/comments$/).map(r => (r.body as { body: string }).body)).toEqual([
      expect.stringContaining(refusal),
    ])
    expect(gh.requestsMatching('POST', /\/issues\/1\/labels$/)).toEqual([])
    expect(gh.requestsMatching('GET', /\/(members|collaborators)\//)).toEqual([])
  })

  it.each([
    ['approvers is a string', 'approvers: alice\n', 'approvers must be a list of GitHub usernames'],
    ['approvers holds a number', 'approvers:\n- alice\n- 42\n', 'approvers must be a list of GitHub usernames'],
    ['reviewers is a mapping', 'approvers:\n- alice\nreviewers:\n  bob: true\n', 'reviewers must be a list of GitHub usernames'],
    ['labels holds a mapping', 'approvers:\n- alice\nlabels:\n- name: sig/node\n', 'labels must be a list of label names'],
  ])('an OWNERS file whose %s fails the run naming the file and the role, before any authorization or write', async (_name, contents, message) => {
    routeApprove(contents)

    const result = await runApprove()

    expect(result.status, result.stdout).toBe(1)
    expect(result.errors).toHaveLength(1)
    expect(result.errors[0]).toContain(`error loading OWNERS files at basesha: Error: OWNERS at OWNERS: ${message}`)
    expect(gh.requestsMatching('POST', /\/issues\/1\/comments$/)).toEqual([])
    expect(gh.requestsMatching('POST', /\/issues\/1\/labels$/)).toEqual([])
    expect(gh.requestsMatching('GET', /\/(members|collaborators)\//)).toEqual([])
  })
})
