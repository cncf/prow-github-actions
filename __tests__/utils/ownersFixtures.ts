import type { HttpHandler } from 'msw'
import { Buffer } from 'node:buffer'

import { http } from 'msw'

import issueCommentEvent from '../fixtures/issues/issueCommentEvent.json'
import * as utils from '../testUtils'

export const repo = `${utils.api}/repos/Codertocat/Hello-World`
// every fixture pull request targets master; its tip is basesha unless a test serves another
export const baseBranch = 'master'
export const baseSha = 'basesha'

export function prCommentEvent(body: string, commenter = 'Codertocat', author = 'some-author') {
  const event = structuredClone(issueCommentEvent)
  event.comment.body = body
  event.comment.user.login = commenter
  event.issue.user.login = author
  return {
    ...event,
    issue: {
      ...event.issue,
      pull_request: {
        url: 'https://api.github.com/repos/Codertocat/Hello-World/pulls/1',
      },
    },
  }
}

export interface ChangedFile {
  filename: string
  previous_filename?: string
  status?: string
}

export function changedFiles(...files: (string | ChangedFile)[]): ChangedFile[] {
  return files.map(f => (typeof f === 'string' ? { filename: f, status: 'modified' } : f))
}

// an open, clean pull request without labels: the OWNERS plugins read its base, tide reads its labels and state
export const pullBody = {
  number: 1,
  state: 'open',
  locked: false,
  draft: false,
  merged: false,
  mergeable: true,
  mergeable_state: 'clean',
  labels: [],
  base: { ref: baseBranch, sha: baseSha },
  head: { sha: 'headsha' },
}

export function pullHandler(observe?: utils.ObserveRequest, overrides: Record<string, unknown> = {}): HttpHandler {
  return http.get(`${repo}/pulls/1`, utils.mockResponse(200, { ...pullBody, ...overrides }, observe))
}

// `GET /branches/{branch}`: the current tip of a base branch, where the OWNERS plugins read the OWNERS files
export function branchHandler(sha = baseSha, branch = baseBranch, observe?: utils.ObserveRequest): HttpHandler {
  return http.get(`${repo}/branches/${branch}`, utils.mockResponse(200, { name: branch, commit: { sha } }, observe))
}

export function filesHandler(files: ChangedFile[], observe?: utils.ObserveRequest): HttpHandler {
  return http.get(`${repo}/pulls/1/files`, utils.mockResponse(200, files, observe))
}

export function blobSha(path: string): string {
  return `blob-${path.replace(/\//g, '-')}`
}

// the base branch tip, then the git tree and blob handlers for the OWNERS files given as { 'sdk/OWNERS': yaml }
export function treeHandlers(
  owners: Record<string, string>,
  options: { truncated?: boolean, observeTree?: utils.ObserveRequest, sha?: string } = {},
): HttpHandler[] {
  const sha = options.sha ?? baseSha
  const tree = Object.keys(owners).map(path => ({
    path,
    mode: '100644',
    type: 'blob',
    sha: blobSha(path),
  }))

  const handlers: HttpHandler[] = [
    branchHandler(sha),
    http.get(
      `${repo}/git/trees/${sha}`,
      utils.mockResponse(
        200,
        { sha, truncated: options.truncated ?? false, tree },
        options.observeTree,
      ),
    ),
  ]

  for (const [path, contents] of Object.entries(owners)) {
    handlers.push(
      http.get(
        `${repo}/git/blobs/${blobSha(path)}`,
        utils.mockResponse(200, {
          sha: blobSha(path),
          encoding: 'base64',
          content: Buffer.from(contents).toString('base64'),
        }),
      ),
    )
  }

  return handlers
}

// a contents API response for a probed OWNERS file (truncated-tree fallback)
export function contentsResponse(path: string, contents: string) {
  return {
    type: 'file',
    encoding: 'base64',
    size: contents.length,
    name: 'OWNERS',
    path,
    content: Buffer.from(contents).toString('base64'),
  }
}

export function prHandlers(
  owners: Record<string, string>,
  files: (string | ChangedFile)[],
  pull: Record<string, unknown> = {},
): HttpHandler[] {
  return [pullHandler(undefined, pull), filesHandler(changedFiles(...files)), ...treeHandlers(owners)]
}
