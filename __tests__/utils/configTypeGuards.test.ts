import type { Octokit } from '@octokit/rest'
import process from 'node:process'
import { delay, http, HttpResponse } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { loadProwConfig, parseProwConfig } from '../../src/utils/config'
import { newOctokit } from '../../src/utils/octokit'
import issueCommentEvent from '../fixtures/issues/issueCommentEvent.json'
import * as utils from '../testUtils'

// src/utils/config.ts: the type half of each "must be a <type>" guard, where
// the existing cases only ever exercise the emptiness half, plus the
// inclusive 24h delay bound and the fetch timeout of an https:// source

describe('parseProwConfig type guards', () => {
  it('rejects a label definition whose color is a yaml number, even one of six digits', () => {
    const malformed = 'kind: yaml malformed, expected a list of values or { values: [...], exclusive: bool }'

    expect(() => parseProwConfig('x', 'kind:\n  - { name: bug, color: 123456 }\n')).toThrow(malformed)
    expect(() => parseProwConfig('x', 'kind:\n  - { name: bug, color: 12 }\n')).toThrow(malformed)
    expect(parseProwConfig('x', 'kind:\n  - { name: bug, color: "123456" }\n').labels?.kind?.definitions).toEqual([
      { name: 'bug', color: '123456' },
    ])
  })

  it.each([
    ['a number', '123'],
    ['a list', '[needs-kind]'],
    ['a mapping', '{ name: needs-kind }'],
  ])('rejects a require_matching_label missing_label that is %s', (_, value) => {
    expect(() => parseProwConfig('x', `require_matching_label:\n  - regexp: ^kind/\n    missing_label: ${value}\n`)).toThrow(
      'x: require_matching_label[0]: missing_label must be a non-empty string',
    )
  })

  it.each([
    ['a number', '123'],
    ['a list', '[hold]'],
    ['a boolean', 'true'],
  ])('rejects a hold.label that is %s', (_, value) => {
    expect(() => parseProwConfig('x', `hold:\n  label: ${value}\n`)).toThrow('x: hold.label must be a non-empty string')
  })

  it('accepts a blunderbuss.delay of exactly 24h and rejects one second more', () => {
    expect(parseProwConfig('x', 'blunderbuss:\n  delay: 24h\n')).toEqual({ blunderbuss: { delay: '24h' } })
    expect(parseProwConfig('x', 'blunderbuss:\n  delay: 1440m\n')).toEqual({ blunderbuss: { delay: '1440m' } })
    expect(() => parseProwConfig('x', 'blunderbuss:\n  delay: 86401s\n')).toThrow('x: blunderbuss.delay must not be longer than 24h')
  })
})

// A bare key (`tide:` with nothing under it, as a file is left after its
// nested lines are commented out) loads as null, which is not undefined, so
// it reaches the section's normalizer. The null half of isMapping is the only
// thing standing between that and a TypeError on the first property read; the
// cases above all pass a list, string, number or boolean instead.
describe('parseProwConfig on a bare key, which yaml loads as null', () => {
  it.each(['tide', 'hold', 'blunderbuss', 'approve', 'lgtm', 'sweep', 'authorization'])('rejects a bare %s: as not a mapping', (key) => {
    expect(() => parseProwConfig('x', `${key}:\n`)).toThrow(`x: ${key} must be a mapping`)
  })

  it('rejects a bare require_matching_label: as not a list', () => {
    expect(() => parseProwConfig('x', 'require_matching_label:\n')).toThrow('x: require_matching_label must be a list')
  })

  it('rejects a bare section under labels, and a bare top-level labels:, as a malformed section', () => {
    const malformed = 'yaml malformed, expected a list of values or { values: [...], exclusive: bool }'

    expect(() => parseProwConfig('x', 'labels:\n  kind:\n')).toThrow(`kind: ${malformed}`)
    // a null `labels` is neither a mapping nor absent, so the file is read in
    // the legacy form, where `labels` is itself a section
    expect(() => parseProwConfig('x', 'labels:\n')).toThrow(`labels: ${malformed}`)
    expect(() => parseProwConfig('x', 'labels:\ntide:\n  merge_method: squash\n')).toThrow(`labels: ${malformed}`)
  })
})

describe('an https:// config source', () => {
  const server = setupServer()
  utils.failTestOnUnhandledRequests(server)
  const context = new utils.MockContext(issueCommentEvent)
  let octokit: Octokit

  beforeAll(() => server.listen(utils.failOnUnhandledRequest))
  beforeEach(() => {
    utils.setupActionsEnv()
    octokit = newOctokit('some-token')
  })
  afterEach(() => server.resetHandlers())
  afterAll(() => server.close())

  it('is fetched under a 5 second timeout signal', async () => {
    process.env.INPUT_CONFIG = 'https://config.example.com/prow.yaml'
    const controller = new AbortController()
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal)
    server.use(
      http.get('https://config.example.com/prow.yaml', async () => {
        // stand in for the clock: the signal fires while the server is still silent
        controller.abort(new DOMException('took too long', 'TimeoutError'))
        await delay('infinite')
        return HttpResponse.text('labels:\n  kind: [from-url]\n')
      }),
      ...utils.noOrgOrRepoConfigExcept(),
    )

    await expect(loadProwConfig(octokit, context)).rejects.toThrow(
      /^could not load prow config from https:\/\/config\.example\.com\/prow\.yaml: .*took too long/,
    )
    expect(timeout).toHaveBeenCalledWith(5000)
  })
})
