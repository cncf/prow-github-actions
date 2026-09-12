import type { Octokit } from '@octokit/rest'
import { Buffer } from 'node:buffer'
import * as core from '@actions/core'
import { http } from 'msw'

import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { handleIssueComment } from '../../src/issueComment/handleIssueComment'
import { addPrefix, getArgumentLabels, getLabelConfig } from '../../src/utils/labeling'
import { newOctokit } from '../../src/utils/octokit'
import issueCommentEvent from '../fixtures/issues/issueCommentEvent.json'

import labelFileContents from '../fixtures/labels/labelFileContentsResp.json'
import malformedFileContents from '../fixtures/labels/labelFileMalformedResponse.json'
import * as utils from '../testUtils'

const server = setupServer()
beforeAll(() =>
  server.listen({
    onUnhandledRequest: 'error',
  }),
)
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

describe('utils labeling', () => {
  beforeEach(() => {
    utils.setupActionsEnv('/area')
  })

  it('can read from both .yaml and .yml label files', async () => {
    issueCommentEvent.comment.body = '/area important'
    const commentContext = new utils.MockContext(issueCommentEvent)

    const observeReq = new utils.ObserveRequest()
    server.use(
      http.post(
        `${utils.api}/repos/Codertocat/Hello-World/issues/1/labels`,
        utils.mockResponse(200, null, observeReq),
      ),
    )

    server.use(
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/contents/.prowlabels.yml`,
        utils.mockResponse(200, labelFileContents),
      ),
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/contents/.prowlabels.yaml`,
        utils.mockResponse(404),
      ),
      ...utils.noOrgOrRepoConfigExcept('.prowlabels.yml', '.prowlabels.yaml'),
    )

    await handleIssueComment(commentContext)
    await observeReq.called()
    expect(await observeReq.body()).toMatchObject({
      labels: ['area/important'],
    })
  })

  it('can error correctly on malformed label.yaml', async () => {
    const spy = vi.spyOn(core, 'setFailed')

    issueCommentEvent.comment.body = '/area important'
    const commentContext = new utils.MockContext(issueCommentEvent)

    server.use(
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/contents/.prowlabels.yml`,
        utils.mockResponse(200, malformedFileContents),
      ),
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/contents/.prowlabels.yaml`,
        utils.mockResponse(404),
      ),
      ...utils.noOrgOrRepoConfigExcept('.prowlabels.yml', '.prowlabels.yaml'),
    )

    await handleIssueComment(commentContext)

    expect(spy).toHaveBeenCalled()
  })

  it('addPrefix joins a prefix with a slash', () => {
    expect(addPrefix('kind', ['bug', 'cleanup'])).toEqual(['kind/bug', 'kind/cleanup'])
  })

  it('addPrefix leaves args unchanged for an empty prefix', () => {
    expect(addPrefix('', ['good-first-issue'])).toEqual(['good-first-issue'])
  })
})

describe('getLabelConfig', () => {
  const context = new utils.MockContext(issueCommentEvent)
  let octokit: Octokit

  beforeEach(() => {
    utils.setupActionsEnv()
    octokit = newOctokit('some-token')
  })

  function serveYaml(text: string) {
    const file = structuredClone(labelFileContents)
    file.content = Buffer.from(text).toString('base64')
    server.use(
      http.get(
        `${utils.api}/repos/Codertocat/Hello-World/contents/.prowlabels.yaml`,
        utils.mockResponse(200, file),
      ),
      ...utils.noOrgOrRepoConfigExcept('.prowlabels.yaml'),
    )
  }

  it('normalizes a plain list into a section without exclusive', async () => {
    serveYaml('triage:\n  - accepted\n  - needs-information\n')

    await expect(getLabelConfig(octokit, context)).resolves.toEqual({
      triage: {
        values: ['accepted', 'needs-information'],
        exclusive: undefined,
        definitions: [{ name: 'accepted' }, { name: 'needs-information' }],
      },
    })
  })

  it('keeps the mapping form with its exclusive flag', async () => {
    serveYaml('level:\n  values: [sandbox, incubation]\n  exclusive: true\nkind:\n  values: [bug]\n')

    await expect(getLabelConfig(octokit, context)).resolves.toEqual({
      level: { values: ['sandbox', 'incubation'], exclusive: true, definitions: [{ name: 'sandbox' }, { name: 'incubation' }] },
      kind: { values: ['bug'], exclusive: undefined, definitions: [{ name: 'bug' }] },
    })
  })

  it.each([
    ['a scalar', 'level: sandbox\n'],
    ['a mapping without values', 'level:\n  exclusive: true\n'],
    ['a non-boolean exclusive', 'level:\n  values: [sandbox]\n  exclusive: yes please\n'],
    ['nested lists', 'level:\n  - [sandbox]\n'],
  ])('rejects %s section', async (_, text) => {
    serveYaml(text)

    await expect(getLabelConfig(octokit, context)).rejects.toThrow(
      `level: yaml malformed, expected a list of values or { values: [...], exclusive: bool }`,
    )
  })

  it('treats a null document as having no sections', async () => {
    serveYaml('---\n')

    await expect(getLabelConfig(octokit, context)).resolves.toEqual({})
  })

  it('getArgumentLabels returns the values of one section', async () => {
    serveYaml('level:\n  values: [sandbox]\n  exclusive: true\n')

    await expect(getArgumentLabels(octokit, context, 'level')).resolves.toEqual(['sandbox'])
  })

  it('getArgumentLabels keeps the missing key error', async () => {
    serveYaml('kind:\n  - cleanup\n')

    await expect(getArgumentLabels(octokit, context, 'level')).rejects.toThrow(
      `level: yaml malformed, expected 'level' top level key`,
    )
  })
})
