import type { FakeGithub } from './fakeGithub'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import pullRequestEvent from '../fixtures/pullReq/pullReqOpenedEvent.json'
import { start } from './fakeGithub'
import { comment, token } from './helpers'
import { runBundle } from './runBundle'

vi.setConfig({ testTimeout: 30_000 })

// every command handler guards against an issue_comment payload without `issue.number` before its first
// api call, and onPrLgtm guards against a pull_request payload without `pull_request.number`. The
// fixtures always carry a number, so the guards are driven here, through dist/index.js, by deleting it
describe('dist/index.js missing issue and pull request number guards', () => {
  let gh: FakeGithub

  beforeAll(async () => {
    gh = await start()
  })
  afterEach(() => gh.reset())
  afterAll(() => gh.close())

  function commentWithoutNumber(body: string) {
    const payload = comment(body) as { issue: { number?: number } }
    delete payload.issue.number
    return payload
  }

  const issueGuard = 'github context payload missing issue number: [object Object]'
  const pullGuard = 'github context payload missing pull number: [object Object]'

  it.each([
    ['/assign', '/assign @someone', issueGuard],
    ['/unassign', '/unassign @someone', issueGuard],
    ['/cc', '/cc @someone', pullGuard],
    ['/uncc', '/uncc @someone', pullGuard],
    ['/approve', '/approve', issueGuard],
    ['/retitle', '/retitle a new title', issueGuard],
    ['/remove', '/remove bug', issueGuard],
    ['/hold', '/hold', issueGuard],
    ['/lgtm', '/lgtm', issueGuard],
    ['/close', '/close', issueGuard],
    ['/lock', '/lock', issueGuard],
    ['/reopen', '/reopen', issueGuard],
    ['/milestone', '/milestone v1', issueGuard],
    ['/meow', '/meow', issueGuard],
    ['/retest', '/retest', issueGuard],
    ['/help', '/help', issueGuard],
    ['/kind', '/kind bug', issueGuard],
  ])('%s on a comment without an issue number fails naming the guard', async (command, body, guard) => {
    const result = await runBundle({
      eventName: 'issue_comment',
      payload: commentWithoutNumber(body),
      inputs: { ...token, 'prow-commands': command },
      apiUrl: gh.url,
    })

    expect(result.status, result.stdout).toBe(1)
    expect(result.errors.some(e => e.includes(`error handling issue comment: Error: ${guard}`)), result.stdout).toBe(true)
  })

  it.each([
    ['/assign', '/assign @someone'],
    ['/cc', '/cc @someone'],
    ['/retitle', '/retitle a new title'],
    ['/close', '/close'],
    ['/lock', '/lock'],
    ['/reopen', '/reopen'],
    ['/milestone', '/milestone v1'],
    ['/meow', '/meow'],
    ['/retest', '/retest'],
  ])('%s without an issue number makes no api call: the guard runs before the first read', async (command, body) => {
    await runBundle({
      eventName: 'issue_comment',
      payload: commentWithoutNumber(body),
      inputs: { ...token, 'prow-commands': command },
      apiUrl: gh.url,
    })

    expect(gh.requests).toEqual([])
  })

  it('the lgtm job on a synchronize payload without a pull request number fails naming the guard', async () => {
    const payload = structuredClone(pullRequestEvent) as { action: string, pull_request: { number?: number } }
    payload.action = 'synchronize'
    delete payload.pull_request.number

    const result = await runBundle({
      eventName: 'pull_request',
      payload,
      inputs: { ...token, jobs: 'lgtm' },
      apiUrl: gh.url,
    })

    expect(result.status, result.stdout).toBe(1)
    expect(result.errors.some(e => e.includes('error handling pull request: Error: github context payload missing pr number: [object Object]')), result.stdout).toBe(true)
  })
})
