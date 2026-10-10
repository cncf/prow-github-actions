import type { HttpHandler } from 'msw'
import { Buffer } from 'node:buffer'

import { http } from 'msw'

import * as utils from '../testUtils'
import { baseBranch, baseSha, blobSha, prCommentEvent, pullBody } from './ownersData'

// the src-free fixture data lives in ownersData so the bundle suite can import it
// without loading src/ into the vitest worker; re-exported here for the unit tests
export { baseBranch, baseSha, blobSha, prCommentEvent, pullBody }

export const repo = `${utils.api}/repos/Codertocat/Hello-World`

export interface ChangedFile {
  filename: string
  previous_filename?: string
  status?: string
}

export function changedFiles(...files: (string | ChangedFile)[]): ChangedFile[] {
  return files.map(f => (typeof f === 'string' ? { filename: f, status: 'modified' } : f))
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
