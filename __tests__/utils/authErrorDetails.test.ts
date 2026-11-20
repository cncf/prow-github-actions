import * as core from '@actions/core'
import { Octokit } from '@octokit/rest'
import { beforeAll, describe, expect, it, vi } from 'vitest'

import { checkCollaborator, checkOrgMember } from '../../src/utils/auth'
import issueCommentEvent from '../fixtures/issues/issueCommentEvent.json'

import * as utils from '../testUtils'

// The membership checks fold whatever the client rejects with into a
// `status=…, message=…` warning. auth.test.ts drives a plain string and a bare
// `{}`; these cases pin the two remaining shapes the fold distinguishes — a
// `null` rejection (`typeof null === 'object'`, so the null guard is what keeps
// `'status' in error` from throwing) and an object whose `message` is not a
// string (which must fall back to `String(error)`, not be interpolated as-is).
// `npx stryker run stryker.nightly.config.mjs --mutate src/utils/auth.ts`
// left `error !== null`, `&&` and `typeof error.message === 'string'` in
// getErrorDetails as its only behavioural survivors without them.

beforeAll(() => {
  utils.setupActionsEnv()
})

const octokit = new Octokit({ auth: 'some-token' })
const context = new utils.MockContext(issueCommentEvent)

describe('getErrorDetails, through the membership checks', () => {
  it('reports status=unknown, message=null when the org membership check rejects with null', async () => {
    const warningSpy = vi.spyOn(core, 'warning')

    vi.spyOn(octokit.orgs, 'checkMembershipForUser').mockRejectedValueOnce(null)

    await expect(checkOrgMember(octokit, context, 'some-user')).resolves.toBe(false)

    expect(warningSpy).toHaveBeenCalledWith(
      'encountered unexpected error: status=unknown, message=null',
    )
  })

  it('falls back to the string form of a rejection whose message is not a string', async () => {
    const warningSpy = vi.spyOn(core, 'warning')

    vi.spyOn(octokit.repos, 'checkCollaborator').mockRejectedValueOnce({ status: 500, message: 42 })

    await expect(checkCollaborator(octokit, context, 'some-user')).resolves.toBe(false)

    expect(warningSpy).toHaveBeenCalledWith(
      'encountered unexpected error checking collaborator status: status=500, message=[object Object]',
    )
  })

  it('keeps a string message and its status when both are present', async () => {
    const warningSpy = vi.spyOn(core, 'warning')

    vi.spyOn(octokit.orgs, 'checkMembershipForUser').mockRejectedValueOnce({ status: 503, message: 'upstream unavailable' })

    await expect(checkOrgMember(octokit, context, 'some-user')).resolves.toBe(false)

    expect(warningSpy).toHaveBeenCalledWith(
      'encountered unexpected error: status=503, message=upstream unavailable',
    )
  })
})
