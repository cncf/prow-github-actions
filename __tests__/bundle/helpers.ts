import type { FakeGithub } from './fakeGithub'
import { Buffer } from 'node:buffer'
import { expect } from 'vitest'

import issueCommentEvent from '../fixtures/issues/issueCommentEvent.json'
import { blobSha, pullBody } from '../utils/ownersFixtures'

export const repo = '/repos/Codertocat/Hello-World'
export const token = { 'github-token': 'some-token' }

// Codertocat's comment `body` on issue #1 (not a pull request), opened by `author`
export function comment(body: string, author = issueCommentEvent.issue.user.login) {
  const payload = structuredClone(issueCommentEvent)
  payload.comment.body = body
  payload.issue.user.login = author
  return payload
}

const orgConfigRepos = ['.project', '.github']
const repoConfigFiles = [
  '.github/prow.yaml',
  '.github/prowlabels.yaml',
  'prow.yaml',
  '.prowlabels.yaml',
  '.github/prow.yml',
  '.github/prowlabels.yml',
  'prow.yml',
  '.prowlabels.yml',
]

// the configuration reads the loader makes before it finds `org` and `repo` (or gives up on a tier)
export function configReads({ org, repo: file }: { org?: string, repo?: string } = {}): string[] {
  const orgReads = orgConfigRepos
    .slice(0, org ? orgConfigRepos.indexOf(org) + 1 : orgConfigRepos.length)
    .map(name => `GET /repos/Codertocat/${name}/contents/prow.yaml`)
  const repoReads = repoConfigFiles
    .slice(0, file ? repoConfigFiles.indexOf(file) + 1 : repoConfigFiles.length)
    .map(path => `GET ${repo}/contents/${encodeURIComponent(path)}`)
  return [...orgReads, ...repoReads]
}

// the OWNERS plugins' reads of what routeOwners serves, before any OWNERS blob
export const ownersReads = [
  `GET ${repo}/pulls/1`,
  `GET ${repo}/pulls/1/files?per_page=100`,
  `GET ${repo}/branches/master`,
  `GET ${repo}/git/trees/basesha?recursive=true`,
]

// the tide gate learns whether the pull request's base branch (master in every fixture) has OWNERS files from
// its tree, once per branch per run, after the pull request read that names the branch; the fake answers 404
// (an empty repository) unless a test routes it
export const ownersProbe = `GET ${repo}/git/trees/master?recursive=true`
// tide asks GraphQL once whether the base branch requires a merge queue: once the gate passes, or when it
// fails on an event (to dequeue the bot's own entry); the fake answers "no queue" unless a test routes it
export const queueRead = 'POST /graphql'

// the reads that authorize `login` when no OWNERS file does: its org membership and its collaborator status
export function membershipReads(login: string) {
  return [`GET /orgs/Codertocat/members/${login}`, `GET ${repo}/collaborators/${login}`]
}

// the repository's label list, as the label commands read it before applying a label
export function repoLabels(...names: string[]) {
  return { status: 200, body: names.map(name => ({ name })) }
}

// the helpers that route or inspect a suite's fake GitHub; the suite starts it in beforeAll, after binding these,
// so `fake` is called on each use
export function helpersFor(fake: () => FakeGithub) {
  function calls() {
    return fake().requests.map(r => `${r.method} ${r.path}`)
  }

  // `reads` in any order, then exactly `rest`: the org and repo tiers are probed concurrently, so the reads have no
  // fixed order among themselves
  function expectRequests(reads: string[], rest: string[]) {
    const recorded = calls()
    expect(recorded.slice(0, reads.length).sort()).toEqual([...reads].sort())
    expect(recorded.slice(reads.length)).toEqual(rest)
  }

  // `commandReads` in any order, then `command`, then the configuration reads in any order (for the post-command
  // sweep's needs-* re-check, or for lgtm.bind_to_commit), then `tail`: on a pull request, tide's calls
  function expectCommandThenConfig(command: string[], tail: string[] = [], commandReads: string[] = []) {
    const recorded = calls()
    expect(recorded.slice(0, commandReads.length).sort()).toEqual([...commandReads].sort())
    const afterAuth = recorded.slice(commandReads.length)
    expect(afterAuth.slice(0, command.length)).toEqual(command)
    const reads = configReads()
    expect(afterAuth.slice(command.length, command.length + reads.length).sort()).toEqual([...reads].sort())
    expect(afterAuth.slice(command.length + reads.length)).toEqual(tail)
  }

  // the pull request, its changed files, the tip of its base branch and the OWNERS files there, as the OWNERS plugins read them
  function routeOwners(ownersFiles: Record<string, string>, files: string[], pull: Record<string, unknown> = {}) {
    const gh = fake()
    gh.route('GET', `${repo}/pulls/1`, { status: 200, body: { ...pullBody, user: { login: 'Codertocat' }, requested_reviewers: [], assignees: [], ...pull } })
    gh.route('GET', `${repo}/pulls/1/files`, {
      status: 200,
      body: files.map(filename => ({ filename, status: 'modified' })),
    })
    gh.route('GET', `${repo}/branches/master`, { status: 200, body: { name: 'master', commit: { sha: 'basesha' } } })
    gh.route('GET', `${repo}/git/trees/basesha`, {
      status: 200,
      body: {
        sha: 'basesha',
        truncated: false,
        tree: Object.keys(ownersFiles).map(path => ({ path, type: 'blob', sha: blobSha(path) })),
      },
    })
    for (const [path, contents] of Object.entries(ownersFiles)) {
      gh.route('GET', `${repo}/git/blobs/${blobSha(path)}`, {
        status: 200,
        body: { encoding: 'base64', content: Buffer.from(contents).toString('base64') },
      })
    }
  }

  return { calls, expectCommandThenConfig, expectRequests, routeOwners }
}
