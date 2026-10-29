import * as core from '@actions/core'
import * as github from '@actions/github'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { actionsPlatform } from '../../src/adapters/actions'

describe('actionsPlatform', () => {
  afterEach(() => {
    delete process.env.GITHUB_API_URL
    delete process.env.GITHUB_WORKFLOW
    delete process.env['INPUT_MERGE-METHOD']
  })

  it.each(['debug', 'info', 'notice', 'warning', 'error', 'setSecret'] as const)('forwards log.%s to @actions/core', (method) => {
    const spy = vi.spyOn(core, method).mockImplementation(() => {})

    actionsPlatform().log[method]('hello')

    expect(spy).toHaveBeenCalledWith('hello')
  })

  it('forwards fail to core.setFailed', () => {
    const spy = vi.spyOn(core, 'setFailed').mockImplementation(() => {})

    actionsPlatform().fail('boom')

    expect(spy).toHaveBeenCalledWith('boom')
  })

  it('reads inputs through core.getInput', () => {
    process.env['INPUT_MERGE-METHOD'] = ' squash '

    expect(actionsPlatform().inputs.get('merge-method')).toBe('squash')
    expect(actionsPlatform().inputs.get('config')).toBe('')
    expect(() => actionsPlatform().inputs.get('config', { required: true })).toThrow(/config/)
  })

  it('defaults the api base url and honours GITHUB_API_URL', () => {
    expect(actionsPlatform().apiBaseUrl()).toBe('https://api.github.com')

    process.env.GITHUB_API_URL = 'https://ghes.example/api/v3'
    expect(actionsPlatform().apiBaseUrl()).toBe('https://ghes.example/api/v3')
  })

  it('reports the current workflow name from GITHUB_WORKFLOW', () => {
    expect(actionsPlatform().currentWorkflowName()).toBeUndefined()

    process.env.GITHUB_WORKFLOW = 'Prow'
    expect(actionsPlatform().currentWorkflowName()).toBe('Prow')
  })

  it('builds the context from github.context', () => {
    // github.context.repo prefers the runner's GITHUB_REPOSITORY over the payload
    delete process.env.GITHUB_REPOSITORY
    github.context.eventName = 'issues'
    github.context.payload = { repository: { name: 'Hello-World', owner: { login: 'Codertocat' } } }

    expect(actionsPlatform().context()).toEqual({
      eventName: 'issues',
      payload: github.context.payload,
      repo: { owner: 'Codertocat', repo: 'Hello-World' },
    })
  })
})
