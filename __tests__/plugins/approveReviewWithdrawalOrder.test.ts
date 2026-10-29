import type { ApprovalEvent, ApprovalState, ApproveSettings } from '../../src/plugins/approve'
import type { PullRequestOwners } from '../../src/utils/pullRequestOwners'
import { describe, expect, it } from 'vitest'

import { withdrawalReason } from '../../src/plugins/approveReview'

// collectApprovalEvents in approve.ts appends every comment before any review, so a
// CHANGES_REQUESTED review submitted before a later `/approve` comment reaches
// withdrawalReason out of chronological order; the reason must still follow time.
describe('withdrawalReason orders events by time, not by arrival', () => {
  const settings: ApproveSettings = { require_self_approval: false, ignore_review_state: false, lgtm_acts_as_approve: false, github_review: true }
  const owners = { number: 1, files: ['x'] } as PullRequestOwners
  const state = { uncoveredFiles: ['x'] } as ApprovalState
  const event = (user: string, kind: ApprovalEvent['kind'], at: number): ApprovalEvent => ({ user, kind, at: new Date(at) })

  it('a later /approve comment listed before an earlier changes-requested review retracts it', () => {
    const events = [event('bob', 'approve', 2), event('bob', 'review-changes', 1)]

    expect(withdrawalReason(owners, state, events, settings)).toBe('no approver covers x')
  })

  it('an earlier /approve comment listed before a later changes-requested review is withdrawn by it', () => {
    const events = [event('bob', 'approve', 1), event('bob', 'review-changes', 2)]

    expect(withdrawalReason(owners, state, events, settings)).toBe('no approver covers x; withdrawn by bob (changes requested)')
  })

  it('a later cancel listed first still wins over the earlier approve', () => {
    const events = [event('carol', 'cancel', 5), event('carol', 'approve', 4)]

    expect(withdrawalReason(owners, state, events, settings)).toBe('no approver covers x; withdrawn by carol (/approve cancel)')
  })
})
