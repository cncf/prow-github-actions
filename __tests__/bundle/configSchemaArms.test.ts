import type { FakeGithub } from './fakeGithub'
import { Buffer } from 'node:buffer'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import labelFileContents from '../fixtures/labels/labelFileContentsResp.json'
import { start } from './fakeGithub'
import { comment, repo, token } from './helpers'
import { runBundle } from './runBundle'

vi.setConfig({ testTimeout: 30_000 })

const source = 'Codertocat/Hello-World:.github/prow.yaml'

function yamlFile(text: string) {
  const file = structuredClone(labelFileContents)
  file.content = Buffer.from(text).toString('base64')
  return file
}

// the schema rejections of parseProwConfig and its normalizers, driven through dist/index.js: a `/kind cleanup`
// against a repository whose .github/prow.yaml is malformed must fail the run naming the source and the field,
// and must not write a label
describe('dist/index.js prow.yaml schema rejections', () => {
  let gh: FakeGithub

  beforeAll(async () => {
    gh = await start()
  })
  afterEach(() => gh.reset())
  afterAll(() => gh.close())

  function run(yaml: string) {
    gh.route('GET', `${repo}/contents/.github%2Fprow.yaml`, { status: 200, body: yamlFile(yaml) })
    gh.route('GET', `${repo}/labels`, { status: 200, body: [{ name: 'kind/cleanup' }] })
    gh.route('POST', `${repo}/issues/1/labels`, { status: 200, body: [] })
    return runBundle({
      eventName: 'issue_comment',
      payload: comment('/kind cleanup'),
      inputs: { ...token, 'prow-commands': '/kind' },
      apiUrl: gh.url,
    })
  }

  it.each([
    ['a top level scalar', 'just a string\n', `${source}: yaml malformed, expected a mapping at the top level`],
    ['a legacy label section that is a scalar', 'kind: bug\n', 'kind: yaml malformed, expected a list of values or { values: [...], exclusive: bool }'],
    ['a label value that is neither a string nor a mapping', 'kind:\n  - 42\n', 'kind: yaml malformed, expected a list of values or { values: [...], exclusive: bool }'],
    ['a label color with a leading #', 'kind:\n  - { name: bug, color: "#d73a4a" }\n', 'kind: invalid color \'#d73a4a\' for label \'bug\', expected 6 hex digits'],
    ['require_matching_label that is not a list', 'require_matching_label: true\n', `${source}: require_matching_label must be a list`],
    ['a require_matching_label rule that is not a mapping', 'require_matching_label:\n  - needs-kind\n', `${source}: require_matching_label[0]: expected a mapping with regexp and missing_label`],
    ['a require_matching_label rule whose regexp is not a string', 'require_matching_label:\n  - { regexp: 1, missing_label: needs-kind }\n', `${source}: require_matching_label[0]: regexp must be a string`],
    ['a require_matching_label rule whose regexp does not compile', 'require_matching_label:\n  - { regexp: "^kind/(", missing_label: needs-kind }\n', `${source}: require_matching_label[0]: regexp does not compile: SyntaxError`],
    ['a require_matching_label rule with an empty missing_label', 'require_matching_label:\n  - { regexp: "^kind/", missing_label: "" }\n', `${source}: require_matching_label[0]: missing_label must be a non-empty string`],
    ['a require_matching_label rule whose prs flag is not a boolean', 'require_matching_label:\n  - { regexp: "^kind/", missing_label: needs-kind, prs: yes please }\n', `${source}: require_matching_label[0]: prs must be a boolean`],
    ['a require_matching_label rule whose missing_comment is not a string', 'require_matching_label:\n  - { regexp: "^kind/", missing_label: needs-kind, missing_comment: [a] }\n', `${source}: require_matching_label[0]: missing_comment must be a string`],
    ['tide that is not a mapping', 'tide: [lgtm]\n', `${source}: tide must be a mapping`],
    ['tide.labels with an empty label name', 'tide:\n  labels: [lgtm, ""]\n', `${source}: tide.labels must be a list of label names`],
    ['an unknown tide.merge_method', 'tide:\n  merge_method: fast-forward\n', `${source}: tide.merge_method must be one of merge, squash, rebase`],
    ['tide.merge_on_events that is not a boolean', 'tide:\n  merge_on_events: always\n', `${source}: tide.merge_on_events must be a boolean`],
    ['an unknown tide.merge_queue mode', 'tide:\n  merge_queue: on\n', `${source}: tide.merge_queue must be one of auto, off`],
    ['blunderbuss that is not a mapping', 'blunderbuss: 2\n', `${source}: blunderbuss must be a mapping`],
    ['blunderbuss.request_count below 1', 'blunderbuss:\n  request_count: 0\n', `${source}: blunderbuss.request_count must be an integer of at least 1`],
    ['blunderbuss.max_request_count below request_count', 'blunderbuss:\n  request_count: 3\n  max_request_count: 2\n', `${source}: blunderbuss.max_request_count must not be lower than request_count`],
    ['blunderbuss.ignore_drafts that is not a boolean', 'blunderbuss:\n  ignore_drafts: never\n', `${source}: blunderbuss.ignore_drafts must be a boolean`],
    ['blunderbuss.ignore_authors with a non-string entry', 'blunderbuss:\n  ignore_authors: [{ login: bot }]\n', `${source}: blunderbuss.ignore_authors must be a list of GitHub usernames`],
    ['approve that is not a mapping', 'approve: true\n', `${source}: approve must be a mapping`],
    ['approve.github_review that is not a boolean', 'approve:\n  github_review: mirror\n', `${source}: approve.github_review must be a boolean`],
    ['lgtm that is not a mapping', 'lgtm: [bind_to_commit]\n', `${source}: lgtm must be a mapping`],
    ['lgtm.bind_to_commit that is not a boolean', 'lgtm:\n  bind_to_commit: 1\n', `${source}: lgtm.bind_to_commit must be a boolean`],
  ])('%s fails the command naming the field, with no label write', async (_name, yaml, message) => {
    const result = await run(yaml)

    expect(result.status, result.stdout).toBe(1)
    expect(result.errors.some(e => e.includes(`could not get labels from yaml: `) && e.includes(message)), result.stdout).toBe(true)
    expect(gh.requestsMatching('POST', /\/issues\/1\/labels$/)).toEqual([])
  })

  it('an unknown top level key next to a labels mapping is ignored and the command still applies', async () => {
    const result = await run('labels:\n  kind: [cleanup]\nunknown_plugin:\n  enabled: true\n')

    expect(result.status, result.stdout).toBe(0)
    expect(result.errors).toEqual([])
    expect(result.stdout).toContain(`${source}: ignoring unknown top level keys: unknown_plugin`)
    expect(gh.requestsMatching('POST', /\/issues\/1\/labels$/)[0].body).toEqual({ labels: ['kind/cleanup'] })
  })
})
