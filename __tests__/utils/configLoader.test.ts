import type { Octokit } from '@octokit/rest'
import { Buffer } from 'node:buffer'
import process from 'node:process'
import { http } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'

import { loadProwConfig, resetProwConfigCache } from '../../src/utils/config'
import { getLabelConfig } from '../../src/utils/labeling'
import { newOctokit } from '../../src/utils/octokit'
import issueCommentEvent from '../fixtures/issues/issueCommentEvent.json'
import labelFileContents from '../fixtures/labels/labelFileContentsResp.json'
import * as utils from '../testUtils'

const server = setupServer()
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

const project = 'Codertocat/.project:prow.yaml'
const dotGithub = 'Codertocat/.github:prow.yaml'

function contentsFile(text: string) {
  const file = structuredClone(labelFileContents)
  file.content = Buffer.from(text).toString('base64')
  return file
}

function serve(source: string, text: string, observe?: utils.ObserveRequest) {
  server.use(http.get(utils.contentsUrl(source), utils.mockResponse(200, contentsFile(text), observe)))
}

function section(...values: string[]) {
  return { values, definitions: values.map(name => ({ name })) }
}

describe('loadProwConfig', () => {
  const context = new utils.MockContext(issueCommentEvent)
  let octokit: Octokit

  beforeEach(() => {
    utils.setupActionsEnv()
    octokit = newOctokit('some-token')
  })

  describe('organization tier', () => {
    it('prefers <owner>/.project over <owner>/.github', async () => {
      const github = new utils.ObserveRequest()
      serve(project, 'labels:\n  kind: [from-project]\n')
      serve(dotGithub, 'labels:\n  kind: [from-github]\n', github)
      server.use(...utils.noOrgOrRepoConfigExcept(project, dotGithub))

      const config = await loadProwConfig(octokit, context)

      expect(config.labels).toEqual({ kind: section('from-project') })
      await expect(github.notCalled()).resolves.toBe('not called')
    })

    it('falls back to <owner>/.github when .project has no prow.yaml', async () => {
      serve(dotGithub, 'labels:\n  kind: [from-github]\n')
      server.use(...utils.noOrgOrRepoConfigExcept(dotGithub))

      const config = await loadProwConfig(octokit, context)

      expect(config.labels).toEqual({ kind: section('from-github') })
    })

    it('fails closed when an org repo answers with something other than 404', async () => {
      server.use(
        http.get(utils.contentsUrl(project), utils.mockResponse(500, { message: 'boom' })),
        ...utils.noOrgOrRepoConfigExcept(project),
      )

      await expect(loadProwConfig(octokit, context)).rejects.toThrow(
        'could not load organization prow config from Codertocat/.project:prow.yaml:',
      )
    })
  })

  describe('repository tier', () => {
    it('prefers .github/prow.yaml over a root .prowlabels.yaml', async () => {
      const legacy = new utils.ObserveRequest()
      serve('.github/prow.yaml', 'labels:\n  kind: [modern]\n')
      serve('.prowlabels.yaml', 'kind: [legacy]\n', legacy)
      server.use(...utils.noOrgOrRepoConfigExcept('.github/prow.yaml', '.prowlabels.yaml'))

      const config = await loadProwConfig(octokit, context)

      expect(config.labels).toEqual({ kind: section('modern') })
      await expect(legacy.notCalled()).resolves.toBe('not called')
    })

    it('reads a legacy .prowlabels.yml when nothing else exists', async () => {
      serve('.prowlabels.yml', 'kind: [legacy]\n')
      server.use(...utils.noOrgOrRepoConfigExcept('.prowlabels.yml'))

      const config = await loadProwConfig(octokit, context)

      expect(config.labels).toEqual({ kind: section('legacy') })
    })

    it('fails closed when a repo probe answers with something other than 404', async () => {
      server.use(
        http.get(utils.contentsUrl('Codertocat/Hello-World:prow.yaml'), utils.mockResponse(403, { message: 'forbidden' })),
        ...utils.noOrgOrRepoConfigExcept('prow.yaml'),
      )

      await expect(loadProwConfig(octokit, context)).rejects.toThrow(
        'could not load prow config from Codertocat/Hello-World:prow.yaml:',
      )
    })
  })

  describe('merging', () => {
    it('repo label sections replace org sections per key and org keys survive', async () => {
      serve(project, 'labels:\n  kind: [org-kind]\n  area: [org-area]\n')
      serve('.prowlabels.yaml', 'kind: [repo-kind]\n')
      server.use(...utils.noOrgOrRepoConfigExcept(project, '.prowlabels.yaml'))

      const config = await loadProwConfig(octokit, context)

      expect(config.labels).toEqual({ kind: section('repo-kind'), area: section('org-area') })
    })

    it('concatenates require_matching_label rules, org first, and shallow-merges tide and hold', async () => {
      serve(project, [
        'require_matching_label:',
        '  - { regexp: ^kind/, missing_label: needs-kind }',
        'tide:',
        '  labels: [lgtm]',
        '  merge_method: merge',
        'hold:',
        '  label: hold',
      ].join('\n'))
      serve('.github/prow.yaml', [
        'require_matching_label:',
        '  - { regexp: ^area/, missing_label: needs-area }',
        'tide:',
        '  merge_method: squash',
      ].join('\n'))
      server.use(...utils.noOrgOrRepoConfigExcept(project, '.github/prow.yaml'))

      const config = await loadProwConfig(octokit, context)

      expect(config.require_matching_label.map(rule => rule.missing_label)).toEqual(['needs-kind', 'needs-area'])
      expect(config.tide).toEqual({ labels: ['lgtm'], merge_method: 'squash' })
      expect(config.hold).toEqual({ label: 'hold' })
      expect(config.sources).toEqual([project, 'Codertocat/Hello-World:.github/prow.yaml'])
    })

    it('returns an empty config with no sources when nothing exists anywhere', async () => {
      server.use(...utils.noOrgOrRepoConfigExcept())

      await expect(loadProwConfig(octokit, context)).resolves.toEqual({
        labels: {},
        require_matching_label: [],
        tide: {},
        hold: {},
        sources: [],
      })
    })
  })

  describe('explicit config input', () => {
    it('owner/repo:path@ref replaces the org tier and is read at that ref', async () => {
      process.env.INPUT_CONFIG = 'cncf/prow-config:configs/prow.yaml@v1'
      const org = new utils.ObserveRequest()
      const explicit = new utils.ObserveRequest()
      server.use(
        http.get(utils.contentsUrl(project), utils.mockResponse(200, contentsFile('labels:\n  kind: [org]\n'), org)),
        http.get(
          `${utils.api}/repos/cncf/prow-config/contents/${encodeURIComponent('configs/prow.yaml')}`,
          utils.mockResponse(200, contentsFile('labels:\n  kind: [explicit]\n  area: [shared]\n'), explicit),
        ),
        ...utils.noOrgOrRepoConfigExcept(project),
      )

      const config = await loadProwConfig(octokit, context)

      expect(config.labels).toEqual({ kind: section('explicit'), area: section('shared') })
      expect(new URL(explicit.ref!.url).searchParams.get('ref')).toBe('v1')
      await expect(org.notCalled()).resolves.toBe('not called')
    })

    it('the repo tier still overrides an explicit source', async () => {
      process.env.INPUT_CONFIG = 'cncf/prow-config:prow.yaml'
      server.use(
        http.get(`${utils.api}/repos/cncf/prow-config/contents/prow.yaml`, utils.mockResponse(200, contentsFile('labels:\n  kind: [explicit]\n'))),
        ...utils.noOrgOrRepoConfigExcept('.prowlabels.yaml'),
      )
      serve('.prowlabels.yaml', 'kind: [repo]\n')

      const config = await loadProwConfig(octokit, context)

      expect(config.labels).toEqual({ kind: section('repo') })
    })

    it('an https:// url is fetched anonymously and replaces the org tier', async () => {
      process.env.INPUT_CONFIG = 'https://config.example.com/prow.yaml'
      const org = new utils.ObserveRequest()
      const url = new utils.ObserveRequest()
      server.use(
        http.get(utils.contentsUrl(project), utils.mockResponse(200, contentsFile('labels:\n  kind: [org]\n'), org)),
        http.get('https://config.example.com/prow.yaml', ({ request }) => {
          url.ref = request
          return new Response('labels:\n  kind: [from-url]\n', { status: 200, headers: { 'Content-Type': 'text/yaml' } })
        }),
        ...utils.noOrgOrRepoConfigExcept(project),
      )

      const config = await loadProwConfig(octokit, context)

      expect(config.labels).toEqual({ kind: section('from-url') })
      expect(url.ref!.headers.get('authorization')).toBeNull()
      await expect(org.notCalled()).resolves.toBe('not called')
    })

    it('rejects an http:// url without making any request', async () => {
      process.env.INPUT_CONFIG = 'http://config.example.com/prow.yaml'

      await expect(loadProwConfig(octokit, context)).rejects.toThrow(
        'config: http:// sources are not allowed, use https://',
      )
    })

    it('rejects an input that is neither owner/repo:path nor a url', async () => {
      process.env.INPUT_CONFIG = 'just-a-file.yaml'

      await expect(loadProwConfig(octokit, context)).rejects.toThrow(
        `config: expected owner/repo:path[@ref] or an https:// url, got 'just-a-file.yaml'`,
      )
    })

    it('fails when the explicit repo file does not exist', async () => {
      process.env.INPUT_CONFIG = 'cncf/prow-config:prow.yaml'
      server.use(
        http.get(`${utils.api}/repos/cncf/prow-config/contents/prow.yaml`, utils.mockResponse(404, { message: 'Not Found' })),
        ...utils.noOrgOrRepoConfigExcept(),
      )

      await expect(loadProwConfig(octokit, context)).rejects.toThrow(
        'could not load prow config from cncf/prow-config:prow.yaml:',
      )
    })

    it('fails when the url does not answer 2xx', async () => {
      process.env.INPUT_CONFIG = 'https://config.example.com/prow.yaml'
      server.use(
        http.get('https://config.example.com/prow.yaml', () => new Response('gone', { status: 410 })),
        ...utils.noOrgOrRepoConfigExcept(),
      )

      await expect(loadProwConfig(octokit, context)).rejects.toThrow(
        'could not load prow config from https://config.example.com/prow.yaml: HTTP 410',
      )
    })
  })

  describe('memoization', () => {
    it('loads once per process for the same repository', async () => {
      const probe = new utils.ObserveRequest()
      serve('.prowlabels.yaml', 'kind: [once]\n', probe)
      server.use(...utils.noOrgOrRepoConfigExcept('.prowlabels.yaml'))

      const first = await loadProwConfig(octokit, context)
      server.resetHandlers()
      const second = await loadProwConfig(octokit, context)

      expect(second).toBe(first)
    })

    it('resetProwConfigCache forces a reload', async () => {
      serve('.prowlabels.yaml', 'kind: [first]\n')
      server.use(...utils.noOrgOrRepoConfigExcept('.prowlabels.yaml'))
      await loadProwConfig(octokit, context)

      resetProwConfigCache()
      server.resetHandlers()
      serve('.prowlabels.yaml', 'kind: [second]\n')
      server.use(...utils.noOrgOrRepoConfigExcept('.prowlabels.yaml'))

      const config = await loadProwConfig(octokit, context)

      expect(config.labels).toEqual({ kind: section('second') })
    })
  })
})

describe('getLabelConfig', () => {
  const context = new utils.MockContext(issueCommentEvent)

  beforeEach(() => utils.setupActionsEnv())

  it('names every probed location when no configuration exists', async () => {
    server.use(...utils.noOrgOrRepoConfigExcept())

    await expect(getLabelConfig(newOctokit('some-token'), context)).rejects.toThrow(
      'no prow configuration found: looked for prow.yaml in Codertocat/.project and Codertocat/.github, '
      + 'and .github/prow.yaml, .github/prowlabels.yaml, prow.yaml, .prowlabels.yaml (.yaml/.yml) in Codertocat/Hello-World',
    )
  })

  it('returns the merged labels from an org-only configuration', async () => {
    serve(project, 'labels:\n  kind: [cleanup]\n')
    server.use(...utils.noOrgOrRepoConfigExcept(project))

    await expect(getLabelConfig(newOctokit('some-token'), context)).resolves.toEqual({ kind: section('cleanup') })
  })
})
