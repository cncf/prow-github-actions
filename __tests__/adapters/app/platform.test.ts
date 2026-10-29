import { describe, expect, it } from 'vitest'

import { memoryDeliveryStore } from '../../../src/adapters/app/dedupe'
import { appPlatform, contextFromDelivery } from '../../../src/adapters/app/platform'
import { settingsFromEnv } from '../../../src/adapters/app/settings'
import issueCommentEvent from '../../fixtures/issues/issueCommentEvent.json'
import { recordingSink, settings, staticTokens, withInstallation } from './testApp'

const delivery = { id: 'd', eventName: 'issue_comment', payload: withInstallation(issueCommentEvent) }

describe('appPlatform', () => {
  it('serves the deployment inputs and an empty string for the unset ones', () => {
    const { platform } = appPlatform(settings, staticTokens(), delivery, () => {})

    expect(platform.inputs.get('prow-commands')).toBe('/close /lgtm')
    expect(platform.inputs.get('jobs')).toBe('')
    expect(() => platform.inputs.get('jobs', { required: true })).toThrow('Input required and not supplied: jobs')
  })

  it('serves the installation token only once resolved', async () => {
    const tokens = staticTokens('tok-7')
    const run = appPlatform(settings, tokens, delivery, () => {})

    expect(() => run.platform.inputs.get('github-token')).toThrow(/resolveToken/)
    await run.resolveToken()
    expect(run.platform.inputs.get('github-token')).toBe('tok-7')
    expect(tokens.requested).toEqual([7])
  })

  it('has no workflow, cannot be read-only on forks, and reports the configured api url', () => {
    const { platform } = appPlatform({ ...settings, apiBaseUrl: 'https://ghes.example/api/v3' }, staticTokens(), delivery, () => {})

    expect(platform.currentWorkflowName()).toBeUndefined()
    expect(platform.capabilities()).toEqual({ readOnlyForkToken: false })
    expect(platform.apiBaseUrl()).toBe('https://ghes.example/api/v3')
    expect(platform.state().configs.size).toBe(0)
  })

  it('records failures and logs them with the delivery fields', () => {
    const { lines, sink } = recordingSink()
    const run = appPlatform(settings, staticTokens(), delivery, sink)

    run.platform.fail('nope')

    expect(run.failures).toEqual(['nope'])
    expect(lines).toEqual([{ level: 'error', delivery: 'd', event: 'issue_comment', repo: 'Codertocat/Hello-World', message: 'nope' }])
  })

  it('redacts the webhook secret, the private key, the token and anything passed to setSecret', async () => {
    const { lines, sink } = recordingSink()
    const run = appPlatform(settings, staticTokens('tok-secret'), delivery, sink)
    await run.resolveToken()
    run.platform.log.setSecret('cat-key')
    run.platform.log.setSecret('')

    run.platform.log.info(`sent ${settings.webhookSecret} ${settings.privateKey} tok-secret cat-key`)

    expect(lines[0]!.message).toBe('sent *** *** *** ***')
  })

  it.each(['debug', 'info', 'notice', 'warning'] as const)('emits %s lines', (level) => {
    const { lines, sink } = recordingSink()
    const { platform } = appPlatform(settings, staticTokens(), delivery, sink)

    platform.log[level]('hello')

    expect(lines).toEqual([expect.objectContaining({ level, message: 'hello' })])
  })

  it('refuses a payload without an installation', () => {
    expect(() => appPlatform(settings, staticTokens(), { ...delivery, payload: structuredClone(issueCommentEvent) }, () => {})).toThrow(/no installation/)
  })
})

describe('contextFromDelivery', () => {
  it('refuses a payload without a repository', () => {
    expect(() => contextFromDelivery({ id: 'd', eventName: 'x', payload: {} })).toThrow(/no repository/)
  })
})

describe('settingsFromEnv', () => {
  const env = { GITHUB_APP_ID: '1', GITHUB_APP_PRIVATE_KEY: 'line1\\nline2', GITHUB_WEBHOOK_SECRET: 's' }

  it('reads the app credentials, unescapes the key, defaults the api url and maps the inputs', () => {
    const s = settingsFromEnv({ ...env, PROW_COMMANDS: '/lgtm', PROW_JOBS: 'lgtm', PROW_MERGE_METHOD: 'squash', PROW_CONFIG: 'o/r:p', PROW_DRY_RUN: 'true', CAT_API_KEY: 'k' })

    expect(s).toEqual({
      appId: '1',
      privateKey: 'line1\nline2',
      webhookSecret: 's',
      apiBaseUrl: 'https://api.github.com',
      inputs: { 'prow-commands': '/lgtm', 'jobs': 'lgtm', 'merge-method': 'squash', 'config': 'o/r:p', 'dry-run': 'true', 'cat-api-key': 'k' },
    })
  })

  it('honours GITHUB_API_URL, defaults jobs to lgtm and leaves the other unset inputs out', () => {
    const s = settingsFromEnv({ ...env, GITHUB_API_URL: 'https://ghes.example/api/v3' })

    expect(s.apiBaseUrl).toBe('https://ghes.example/api/v3')
    expect(s.inputs).toEqual({ jobs: 'lgtm' })
  })

  it.each(['GITHUB_APP_ID', 'GITHUB_APP_PRIVATE_KEY', 'GITHUB_WEBHOOK_SECRET'])('requires %s', (name) => {
    expect(() => settingsFromEnv({ ...env, [name]: '' })).toThrow(`${name} must be set`)
  })
})

describe('memoryDeliveryStore', () => {
  it('remembers ids up to its capacity and forgets the oldest first', async () => {
    const store = memoryDeliveryStore(2)

    expect(await store.seen('a')).toBe(false)
    expect(await store.seen('a')).toBe(true)
    expect(await store.seen('b')).toBe(false)
    expect(await store.seen('c')).toBe(false)
    expect(await store.seen('a')).toBe(false)
  })
})
