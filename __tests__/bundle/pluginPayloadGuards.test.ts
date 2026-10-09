import type { FakeGithub } from './fakeGithub'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import pullRequestEvent from '../fixtures/pullReq/pullReqOpenedEvent.json'
import { start } from './fakeGithub'
import { comment, token } from './helpers'
import { runBundle } from './runBundle'

vi.setConfig({ testTimeout: 30_000 })

// the event-driven plugins guard against a payload without the object they act on before their first
// api call: require-matching-label and blunderbuss on a pull_request event with no `pull_request`,
// ok-to-test on a `synchronize` whose pull request carries the label but no `head`, and tide's
// post-command gate on an issue_comment with no `issue`. The fixtures always carry them, so the guards
// are driven here, through dist/index.js, by deleting the object
describe('dist/index.js plugin payload guards', () => {
  let gh: FakeGithub

  beforeAll(async () => {
    gh = await start()
  })
  afterEach(() => gh.reset())
  afterAll(() => gh.close())

  function pullRequestPayload(action: string) {
    const payload = structuredClone(pullRequestEvent) as { action: string, pull_request?: Record<string, unknown> }
    payload.action = action
    return payload
  }

  it('an opened pull_request event without a pull request fails naming the require-matching-label and blunderbuss guards', async () => {
    const payload = pullRequestPayload('opened')
    delete payload.pull_request

    const result = await runBundle({ eventName: 'pull_request', payload, inputs: token, apiUrl: gh.url })

    expect(result.status, result.stdout).toBe(1)
    expect(result.errors.some(e => e.includes('github context payload missing issue or pull request')), result.stdout).toBe(true)
    expect(result.errors.some(e => e.includes('github context payload missing pull request:')), result.stdout).toBe(true)
    expect(gh.requests).toEqual([])
  })

  it('a synchronize of a pull request carrying ok-to-test but no head fails naming the trigger guard', async () => {
    const payload = pullRequestPayload('synchronize')
    payload.pull_request = { number: pullRequestEvent.pull_request.number, labels: [{ name: 'ok-to-test' }] }

    const result = await runBundle({ eventName: 'pull_request', payload, inputs: token, apiUrl: gh.url })

    expect(result.status, result.stdout).toBe(1)
    expect(result.errors.some(e => e.includes('github context payload missing pull request head')), result.stdout).toBe(true)
    expect(gh.requestsMatching('POST', /\/approve$/)).toEqual([])
  })

  it('a label-writing command on a comment without an issue fails naming the tide guard after the command\'s own', async () => {
    const payload = comment('/lgtm') as { issue?: unknown }
    delete payload.issue

    const result = await runBundle({ eventName: 'issue_comment', payload, inputs: { ...token, 'prow-commands': '/lgtm' }, apiUrl: gh.url })

    expect(result.status, result.stdout).toBe(1)
    expect(result.errors.some(e => e.includes('github context payload missing issue number')), result.stdout).toBe(true)
    expect(result.errors.some(e => e.includes('github context payload missing issue:')), result.stdout).toBe(true)
    expect(gh.requests).toEqual([])
  })
})
