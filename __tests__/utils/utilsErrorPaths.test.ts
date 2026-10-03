import type { Octokit } from '@octokit/rest'
import { Buffer } from 'node:buffer'
import process from 'node:process'
import { http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { createCommentOnce } from '../../src/utils/comments'
import { loadProwConfig, parseProwConfig } from '../../src/utils/config'
import { assertLabelsExist, getCurrentLabels } from '../../src/utils/labeling'
import { matchesLabelPattern } from '../../src/utils/labelMatch'
import { newOctokit } from '../../src/utils/octokit'
import issueCommentEvent from '../fixtures/issues/issueCommentEvent.json'
import labelFileContents from '../fixtures/labels/labelFileContentsResp.json'
import * as utils from '../testUtils'

const server = setupServer()
beforeAll(() => server.listen(utils.failOnUnhandledRequest))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

const repo = `${utils.api}/repos/Codertocat/Hello-World`

describe('matchesLabelPattern middle parts', () => {
  it.each([
    // the middle part is absent between the anchored ends
    ['a*b*c', 'a-x-c'],
    // the middle part only occurs inside the anchored tail
    ['a*b*bc', 'abc'],
    ['a*b*c*d', 'a-b-x-d'],
  ])('%s does not match %s', (pattern, label) => {
    expect(matchesLabelPattern(pattern, label)).toBe(false)
  })
})

describe('parseProwConfig blunderbuss', () => {
  it('compares max_request_count against the default request_count of 1', () => {
    expect(parseProwConfig('x', 'blunderbuss:\n  max_request_count: 1\n')).toEqual({
      blunderbuss: { max_request_count: 1 },
    })
  })
})

describe('utils error paths', () => {
  const context = new utils.MockContext(issueCommentEvent)
  let octokit: Octokit

  beforeEach(() => {
    utils.setupActionsEnv()
    octokit = newOctokit('some-token')
  })

  describe('assertLabelsExist', () => {
    it('wraps a failure to list the repository labels', async () => {
      server.use(http.get(`${repo}/labels`, utils.mockResponse(500, { message: 'boom' })))

      await expect(assertLabelsExist(octokit, context, ['kind/bug'])).rejects.toThrow(
        'could not list the repository labels:',
      )
    })
  })

  describe('getCurrentLabels', () => {
    it('accepts string labels and objects without a name', async () => {
      server.use(
        http.get(`${repo}/issues/1`, utils.mockResponse(200, {
          number: 1,
          labels: ['plain', { name: 'kind/bug' }, { id: 7 }],
        })),
      )

      await expect(getCurrentLabels(octokit, context, 1)).resolves.toEqual(['plain', 'kind/bug', ''])
    })

    it('wraps a failure to read the issue', async () => {
      server.use(http.get(`${repo}/issues/1`, utils.mockResponse(500, { message: 'boom' })))

      await expect(getCurrentLabels(octokit, context, 1)).rejects.toThrow('could not get issue:')
    })
  })

  describe('createCommentOnce', () => {
    const marker = '<!-- prow-github-actions/test: abc1234 -->'

    it('does not post again when a bot comment already carries the marker', async () => {
      const post = new utils.ObserveRequest()
      server.use(
        http.get(`${repo}/issues/1/comments`, utils.mockResponse(200, [
          { id: 1, body: `someone else said ${marker}`, user: { login: 'alice', type: 'User' } },
          { id: 2, body: `explained\n\n${marker}`, user: { login: 'github-actions[bot]', type: 'Bot' } },
        ])),
        http.post(`${repo}/issues/1/comments`, utils.mockResponse(201, { id: 3 }, post)),
      )

      await expect(createCommentOnce(octokit, context, 1, marker, 'explained')).resolves.toBe(false)
      await expect(post.notCalled()).resolves.toBe('not called')
    })

    it('ignores a human comment carrying the marker and posts', async () => {
      const post = new utils.ObserveRequest()
      server.use(
        http.get(`${repo}/issues/1/comments`, utils.mockResponse(200, [
          { id: 1, body: marker, user: { login: 'alice', type: 'User' } },
          { id: 2, body: null, user: { login: 'github-actions[bot]', type: 'Bot' } },
        ])),
        http.post(`${repo}/issues/1/comments`, utils.mockResponse(201, { id: 3 }, post)),
      )

      await expect(createCommentOnce(octokit, context, 1, marker, 'explained')).resolves.toBe(true)
      await post.called()
      expect(await post.body()).toEqual({ body: `explained\n\n${marker}` })
    })
  })

  describe('loadProwConfig explicit sources', () => {
    const explicitUrl = `${utils.api}/repos/cncf/prow-config/contents/prow.yaml`

    it('wraps a non-404 failure reading the explicit repo file', async () => {
      process.env.INPUT_CONFIG = 'cncf/prow-config:prow.yaml'
      server.use(
        http.get(explicitUrl, utils.mockResponse(500, { message: 'boom' })),
        ...utils.noOrgOrRepoConfigExcept(),
      )

      await expect(loadProwConfig(octokit, context)).rejects.toThrow(
        'could not load prow config from cncf/prow-config:prow.yaml: HttpError',
      )
    })

    it('rejects an explicit repo path that is a directory', async () => {
      process.env.INPUT_CONFIG = 'cncf/prow-config:prow.yaml'
      server.use(
        http.get(explicitUrl, utils.mockResponse(200, [{ ...labelFileContents, name: 'a.yaml' }])),
        ...utils.noOrgOrRepoConfigExcept(),
      )

      await expect(loadProwConfig(octokit, context)).rejects.toThrow(
        'could not load prow config from cncf/prow-config:prow.yaml: TypeError: prow.yaml is not a file',
      )
    })

    it('rejects an explicit repo file whose content is not a string', async () => {
      process.env.INPUT_CONFIG = 'cncf/prow-config:prow.yaml'
      server.use(
        http.get(explicitUrl, utils.mockResponse(200, { ...labelFileContents, content: undefined, encoding: 'base64' })),
        ...utils.noOrgOrRepoConfigExcept(),
      )

      await expect(loadProwConfig(octokit, context)).rejects.toThrow('prow.yaml is not a file')
    })

    it('wraps a network failure fetching an https:// url', async () => {
      process.env.INPUT_CONFIG = 'https://config.example.com/prow.yaml'
      server.use(
        http.get('https://config.example.com/prow.yaml', () => HttpResponse.error()),
        ...utils.noOrgOrRepoConfigExcept(),
      )

      await expect(loadProwConfig(octokit, context)).rejects.toThrow(
        // msw 2 surfaces HttpResponse.error() as "Failed to fetch", msw 3 as undici's "fetch failed"
        /^could not load prow config from https:\/\/config\.example\.com\/prow\.yaml: TypeError: (?:Failed to fetch|fetch failed)$/,
      )
    })

    it('decodes the explicit file with the encoding GitHub reports', async () => {
      process.env.INPUT_CONFIG = 'cncf/prow-config:prow.yaml'
      const text = 'labels:\n  kind: [explicit]\n'
      server.use(
        http.get(explicitUrl, utils.mockResponse(200, { ...labelFileContents, content: Buffer.from(text).toString('base64'), encoding: 'base64' })),
        ...utils.noOrgOrRepoConfigExcept(),
      )

      const config = await loadProwConfig(octokit, context)

      expect(config.labels).toEqual({ kind: { values: ['explicit'], definitions: [{ name: 'explicit' }] } })
    })
  })
})
