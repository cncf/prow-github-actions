import type { HttpHandler } from 'msw'
import { Buffer } from 'node:buffer'

import { http } from 'msw'

import issueCommentEvent from '../fixtures/issues/issueCommentEvent.json'
import * as utils from '../testUtils'

export const repo = `${utils.api}/repos/Codertocat/Hello-World`
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

export function pullHandler(observe?: utils.ObserveRequest): HttpHandler {
  return http.get(`${repo}/pulls/1`, utils.mockResponse(200, { base: { sha: baseSha } }, observe))
}

export function filesHandler(files: ChangedFile[], observe?: utils.ObserveRequest): HttpHandler {
  return http.get(`${repo}/pulls/1/files`, utils.mockResponse(200, files, observe))
}

export function blobSha(path: string): string {
  return `blob-${path.replace(/\//g, '-')}`
}

// git tree and blob handlers for the OWNERS files given as { 'sdk/OWNERS': yaml }
export function treeHandlers(
  owners: Record<string, string>,
  options: { truncated?: boolean, observeTree?: utils.ObserveRequest } = {},
): HttpHandler[] {
  const tree = Object.keys(owners).map(path => ({
    path,
    mode: '100644',
    type: 'blob',
    sha: blobSha(path),
  }))

  const handlers: HttpHandler[] = [
    http.get(
      `${repo}/git/trees/${baseSha}`,
      utils.mockResponse(
        200,
        { sha: baseSha, truncated: options.truncated ?? false, tree },
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
): HttpHandler[] {
  return [pullHandler(), filesHandler(changedFiles(...files)), ...treeHandlers(owners)]
}
