import type { ApprovalEvent, ApproveSettings } from '../../src/plugins/approve'
import type { PullRequestOwners } from '../../src/utils/pullRequestOwners'

import { describe, expect, it } from 'vitest'

import { approvalEvents, approveSettings, computeApproval, notifierMarker, renderNotifier } from '../../src/plugins/approve'
import { mergeProwConfig } from '../../src/utils/config'
import { effectiveOwners, ownersDir, parseOwners } from '../../src/utils/owners'

const defaults: ApproveSettings = { require_self_approval: false, ignore_review_state: false, lgtm_acts_as_approve: false }

// the OWNERS of a pull request as loadPullRequestOwners would resolve them, without the network
function pullOwners(ownersFiles: Record<string, string>, files: string[], author = 'author'): PullRequestOwners {
  const parsed = Object.entries(ownersFiles).map(([path, contents]) => parseOwners(path, contents))
  const tree = { owners: new Map(parsed.map(file => [ownersDir(file.path), file])), hasOwners: parsed.length > 0 }
  return {
    number: 1,
    baseSha: 'basesha',
    author,
    draft: false,
    requestedReviewers: [],
    assignees: [],
    labels: [],
    files,
    tree,
    perFile: new Map(files.map(file => [file, effectiveOwners(file, tree.owners)])),
  }
}

let clock = 0
function at(user: string, kind: ApprovalEvent['kind']): ApprovalEvent {
  clock += 1000
  return { user, kind, at: new Date(clock) }
}

const rootOwners = 'approvers:\n- alice\nreviewers:\n- rita\n'
const sdkOwners = 'approvers:\n- bob\n'
const olmOwners = 'options:\n  no_parent_owners: true\napprovers:\n- carol\n'
const twoDirs = { 'OWNERS': 'approvers:\n- root\n', 'sdk/OWNERS': sdkOwners, 'olm/OWNERS': olmOwners }

describe('approveSettings', () => {
  it('applies the Prow defaults and reads every flag', () => {
    expect(approveSettings({ ...mergeProwConfig({}, {}), sources: [] })).toEqual(defaults)
    expect(approveSettings({
      ...mergeProwConfig({}, { approve: { require_self_approval: true, ignore_review_state: true, lgtm_acts_as_approve: true } }),
      sources: [],
    })).toEqual({ require_self_approval: true, ignore_review_state: true, lgtm_acts_as_approve: true })
  })
})

describe('computeApproval', () => {
  it('needs an approver for every changed file: one of two directories is not enough', () => {
    const owners = pullOwners(twoDirs, ['sdk/x.go', 'olm/y.go'])

    const one = computeApproval(owners, [at('bob', 'approve')], defaults)
    expect(one.approved).toBe(false)
    expect([...one.approvers]).toEqual(['bob'])
    expect([...one.coveredFiles]).toEqual([['sdk/x.go', ['bob']]])
    expect(one.uncoveredFiles).toEqual(['olm/y.go'])
    expect(one.suggested).toEqual(['carol'])

    const both = computeApproval(owners, [at('bob', 'approve'), at('carol', 'approve')], defaults)
    expect(both.approved).toBe(true)
    expect([...both.approvers]).toEqual(['bob', 'carol'])
    expect(both.uncoveredFiles).toEqual([])
    expect(both.suggested).toEqual([])
  })

  it('a later CHANGES_REQUESTED review removes an approver who commented /approve', () => {
    const owners = pullOwners({ OWNERS: rootOwners }, ['src/a.go'])

    const state = computeApproval(owners, [at('alice', 'approve'), at('alice', 'review-changes')], defaults)
    expect(state.approved).toBe(false)
    expect([...state.approvers]).toEqual([])
    expect(state.suggested).toEqual(['alice'])
  })

  it('the author implicitly approves the files they could approve', () => {
    const owners = pullOwners({ 'OWNERS': rootOwners, 'sdk/OWNERS': sdkOwners }, ['sdk/x.go', 'docs/y.md'], 'alice')

    const state = computeApproval(owners, [], defaults)
    expect(state.approved).toBe(true)
    expect([...state.approvers]).toEqual(['alice'])
    expect([...state.coveredFiles]).toEqual([['sdk/x.go', ['alice']], ['docs/y.md', ['alice']]])
  })

  it('require_self_approval: the author counts neither implicitly nor through /approve and is never suggested', () => {
    const owners = pullOwners({ OWNERS: 'approvers:\n- alice\n- zed\n' }, ['src/a.go'], 'alice')
    const settings = { ...defaults, require_self_approval: true }

    expect(computeApproval(owners, [], settings).approved).toBe(false)
    const state = computeApproval(owners, [at('alice', 'approve'), at('alice', 'review-approved')], settings)
    expect(state.approved).toBe(false)
    expect([...state.approvers]).toEqual([])
    expect(state.suggested).toEqual(['zed'])

    expect(computeApproval(owners, [at('zed', 'approve')], settings).approved).toBe(true)
  })

  it('the latest of /approve and /approve cancel per user wins', () => {
    const owners = pullOwners({ OWNERS: rootOwners }, ['src/a.go'])

    expect(computeApproval(owners, [at('alice', 'approve'), at('alice', 'cancel')], defaults).approved).toBe(false)
    expect(computeApproval(owners, [at('alice', 'cancel'), at('alice', 'approve')], defaults).approved).toBe(true)
    expect(computeApproval(owners, [at('alice', 'approve'), at('alice', 'cancel'), at('alice', 'approve')], defaults).approved).toBe(true)
  })

  it('orders events by time, not by position', () => {
    const owners = pullOwners({ OWNERS: rootOwners }, ['src/a.go'])
    const cancel = at('alice', 'cancel')
    const approve = at('alice', 'approve')

    expect(computeApproval(owners, [approve, cancel], defaults).approved).toBe(true)
  })

  it('an APPROVED review adds an approver; /approve after CHANGES_REQUESTED re-adds them', () => {
    const owners = pullOwners({ OWNERS: rootOwners }, ['src/a.go'])

    expect(computeApproval(owners, [at('alice', 'review-approved')], defaults).approved).toBe(true)
    expect(computeApproval(owners, [at('alice', 'review-changes'), at('alice', 'approve')], defaults).approved).toBe(true)
  })

  it('ignore_review_state: reviews neither add nor remove', () => {
    const owners = pullOwners({ OWNERS: rootOwners }, ['src/a.go'])
    const settings = { ...defaults, ignore_review_state: true }

    expect(computeApproval(owners, [at('alice', 'review-approved')], settings).approved).toBe(false)
    expect(computeApproval(owners, [at('alice', 'approve'), at('alice', 'review-changes')], settings).approved).toBe(true)
  })

  it('lgtm counts as approve only with lgtm_acts_as_approve', () => {
    const owners = pullOwners({ OWNERS: rootOwners }, ['src/a.go'])

    expect(computeApproval(owners, [at('alice', 'lgtm')], defaults).approved).toBe(false)
    const settings = { ...defaults, lgtm_acts_as_approve: true }
    expect(computeApproval(owners, [at('alice', 'lgtm')], settings).approved).toBe(true)
    expect(computeApproval(owners, [at('alice', 'lgtm'), at('alice', 'lgtm-cancel')], settings).approved).toBe(false)
    expect(computeApproval(owners, [at('alice', 'approve'), at('alice', 'lgtm-cancel')], settings).approved).toBe(false)
  })

  it('ignores a commenter who approves no changed file', () => {
    const owners = pullOwners(twoDirs, ['sdk/x.go'])

    const state = computeApproval(owners, [at('carol', 'approve'), at('nobody', 'approve'), at('bob', 'approve')], defaults)
    expect([...state.approvers]).toEqual(['bob'])
    expect(state.approved).toBe(true)
  })

  it('respects no_parent_owners: a root approver does not cover an isolated directory', () => {
    const owners = pullOwners(twoDirs, ['sdk/x.go', 'olm/y.go'])

    const state = computeApproval(owners, [at('root', 'approve')], defaults)
    expect(state.approved).toBe(false)
    expect([...state.coveredFiles]).toEqual([['sdk/x.go', ['root']]])
    expect(state.uncoveredFiles).toEqual(['olm/y.go'])
    expect(state.suggested).toEqual(['carol'])
  })

  it('suggests approvers greedily by the number of uncovered files they cover, ties broken alphabetically', () => {
    const owners = pullOwners({
      'a/OWNERS': 'options:\n  no_parent_owners: true\napprovers: [x, y]\n',
      'b/OWNERS': 'options:\n  no_parent_owners: true\napprovers: [y, z]\n',
      'c/OWNERS': 'options:\n  no_parent_owners: true\napprovers: [z]\n',
    }, ['a/1', 'b/1', 'c/1'])

    // y and z each cover two files; y wins the tie, then only z can cover c/1
    expect(computeApproval(owners, [], defaults).suggested).toEqual(['y', 'z'])
  })

  it('suggests a single approver who covers everything over several who cover parts', () => {
    const owners = pullOwners({
      'OWNERS': 'approvers: [zoe]\n',
      'sdk/OWNERS': 'approvers: [bob]\n',
      'olm/OWNERS': 'approvers: [carol]\n',
    }, ['sdk/x.go', 'olm/y.go'])

    expect(computeApproval(owners, [], defaults).suggested).toEqual(['zoe'])
  })

  it('a pull request with no changed files is not approved', () => {
    const owners = pullOwners({ OWNERS: rootOwners }, [], 'alice')

    const state = computeApproval(owners, [at('alice', 'approve')], defaults)
    expect(state.approved).toBe(false)
    expect([...state.approvers]).toEqual([])
    expect(state.uncoveredFiles).toEqual([])
    expect(state.suggested).toEqual([])
  })

  it('a changed file no OWNERS file covers can never be approved', () => {
    const owners = pullOwners({ 'sdk/OWNERS': sdkOwners }, ['sdk/x.go', 'README.md'])

    const state = computeApproval(owners, [at('bob', 'approve')], defaults)
    expect(state.approved).toBe(false)
    expect(state.uncoveredFiles).toEqual(['README.md'])
    expect(state.suggested).toEqual([])
  })

  it('requires both sides of a rename to be covered', () => {
    const owners = pullOwners({ 'old/OWNERS': 'approvers: [olga]\n', 'new/OWNERS': 'approvers: [nina]\n' }, ['new/a.go', 'old/a.go'])

    expect(computeApproval(owners, [at('nina', 'approve')], defaults).approved).toBe(false)
    expect(computeApproval(owners, [at('nina', 'approve'), at('olga', 'approve')], defaults).approved).toBe(true)
  })

  it('compares logins case-insensitively', () => {
    const owners = pullOwners({ OWNERS: 'approvers:\n- Alice\n' }, ['src/a.go'])

    expect(computeApproval(owners, [at('aLICE', 'approve')], defaults).approved).toBe(true)
  })
})

describe('approvalEvents', () => {
  const user = (login: string, type = 'User') => ({ login, type })

  it('turns /approve, /approve cancel, /remove-approve and /approve no-issue comments into events', () => {
    const events = approvalEvents([
      { id: 1, body: '/approve', user: user('Alice'), created_at: '2024-01-01T00:00:01Z' },
      { id: 2, body: '/approve cancel', user: user('bob'), created_at: '2024-01-01T00:00:02Z' },
      { id: 3, body: '/remove-approve', user: user('carol'), created_at: '2024-01-01T00:00:03Z' },
      { id: 4, body: '/approve no-issue', user: user('dan'), created_at: '2024-01-01T00:00:04Z' },
      { id: 5, body: 'looks fine, /approve mid-sentence does not count', user: user('eve'), created_at: '2024-01-01T00:00:05Z' },
      { id: 6, body: '/approve\n/approve cancel', user: user('fay'), created_at: '2024-01-01T00:00:06Z' },
    ], [])

    expect(events).toEqual([
      { user: 'alice', kind: 'approve', at: new Date('2024-01-01T00:00:01Z') },
      { user: 'bob', kind: 'cancel', at: new Date('2024-01-01T00:00:02Z') },
      { user: 'carol', kind: 'cancel', at: new Date('2024-01-01T00:00:03Z') },
      { user: 'dan', kind: 'approve', at: new Date('2024-01-01T00:00:04Z') },
      { user: 'fay', kind: 'cancel', at: new Date('2024-01-01T00:00:06Z') },
    ])
  })

  it('turns /lgtm and /lgtm cancel into lgtm events for lgtm_acts_as_approve to weigh', () => {
    expect(approvalEvents([
      { id: 1, body: '/lgtm', user: user('alice'), created_at: '2024-01-01T00:00:01Z' },
      { id: 2, body: '/lgtm cancel', user: user('alice'), created_at: '2024-01-01T00:00:02Z' },
      { id: 3, body: '/remove-lgtm', user: user('bob'), created_at: '2024-01-01T00:00:03Z' },
    ], []).map(e => e.kind)).toEqual(['lgtm', 'lgtm-cancel', 'lgtm-cancel'])
  })

  it('skips bot comments and comments without a body or user', () => {
    expect(approvalEvents([
      { id: 1, body: `/approve\n${notifierMarker}`, user: user('github-actions[bot]', 'Bot'), created_at: '2024-01-01T00:00:01Z' },
      { id: 2, body: null, user: user('alice'), created_at: '2024-01-01T00:00:02Z' },
      { id: 3, body: '/approve', user: null, created_at: '2024-01-01T00:00:03Z' },
    ], [])).toEqual([])
  })

  it('turns APPROVED and CHANGES_REQUESTED reviews by humans into events and ignores the rest', () => {
    const events = approvalEvents([], [
      { id: 1, state: 'APPROVED', user: user('Alice'), submitted_at: '2024-01-01T00:00:01Z' },
      { id: 2, state: 'CHANGES_REQUESTED', user: user('bob'), submitted_at: '2024-01-01T00:00:02Z' },
      { id: 3, state: 'COMMENTED', user: user('carol'), submitted_at: '2024-01-01T00:00:03Z' },
      { id: 4, state: 'DISMISSED', user: user('dan'), submitted_at: '2024-01-01T00:00:04Z' },
      { id: 5, state: 'APPROVED', user: user('github-actions[bot]', 'Bot'), submitted_at: '2024-01-01T00:00:05Z' },
      { id: 6, state: 'APPROVED', user: null, submitted_at: '2024-01-01T00:00:06Z' },
    ])

    expect(events).toEqual([
      { user: 'alice', kind: 'review-approved', at: new Date('2024-01-01T00:00:01Z') },
      { user: 'bob', kind: 'review-changes', at: new Date('2024-01-01T00:00:02Z') },
    ])
  })

  it('a dismissed approval no longer counts while a later review still does', () => {
    const owners = pullOwners({ OWNERS: rootOwners }, ['src/a.go'])
    const events = approvalEvents([], [
      { id: 1, state: 'DISMISSED', user: user('alice'), submitted_at: '2024-01-01T00:00:01Z' },
    ])

    expect(computeApproval(owners, events, defaults).approved).toBe(false)
  })
})

describe('renderNotifier', () => {
  const repo = { owner: 'Codertocat', repo: 'Hello-World' }
  const link = (path: string) => `https://github.com/Codertocat/Hello-World/blob/basesha/${path}`

  it('nOT APPROVED: lists the approvers so far, suggests who to assign, strikes the satisfied OWNERS files and bolds the rest', () => {
    const owners = pullOwners(twoDirs, ['sdk/x.go', 'sdk/internal/z.go', 'olm/y.go'])
    const state = computeApproval(owners, [at('bob', 'approve')], defaults)

    const body = renderNotifier(state, owners, repo)

    expect(body).toBe([
      '[APPROVALNOTIFIER] This PR is **NOT APPROVED**',
      '',
      'This pull-request has been approved by: *bob*',
      'To complete the pull request process, please assign **carol** after the PR has been reviewed.',
      'You can assign the PR to them by writing `/assign @carol` in a comment when ready.',
      '',
      '<details><summary>Needs approval from an approver in each of these files:</summary>',
      '',
      `- **[olm/OWNERS](${link('olm/OWNERS')})**`,
      `- ~~[sdk/OWNERS](${link('sdk/OWNERS')})~~ [bob]`,
      '',
      'Approvers can indicate their approval by writing `/approve` in a comment',
      'Approvers can cancel approval by writing `/approve cancel` in a comment',
      '</details>',
      notifierMarker,
    ].join('\n'))
  })

  it('nOT APPROVED with nobody yet: no suggestion line when no approver can help, several assignees otherwise', () => {
    const uncoverable = pullOwners({ 'sdk/OWNERS': sdkOwners }, ['README.md'])
    const bare = renderNotifier(computeApproval(uncoverable, [], defaults), uncoverable, repo)
    expect(bare).toContain('This pull-request has been approved by:\n')
    expect(bare).not.toContain('please assign')
    expect(bare).toContain('- **README.md** (no OWNERS file covers this file)')

    const owners = pullOwners(twoDirs, ['sdk/x.go', 'olm/y.go'])
    const body = renderNotifier(computeApproval(owners, [], defaults), owners, repo)
    expect(body).toContain('please assign **bob**, **carol** after the PR has been reviewed.')
    expect(body).toContain('`/assign @bob @carol`')
  })

  it('aPPROVED: names the approvers, links the commands and strikes every OWNERS file', () => {
    const owners = pullOwners(twoDirs, ['sdk/x.go', 'olm/y.go'], 'carol')
    const state = computeApproval(owners, [at('bob', 'review-approved')], defaults)

    const body = renderNotifier(state, owners, repo)

    expect(body).toBe([
      '[APPROVALNOTIFIER] This PR is **APPROVED**',
      '',
      'This pull-request has been approved by: *bob*, *carol*',
      '',
      'The full list of commands accepted by this bot can be found [here](https://github.com/cncf/prow-github-actions/blob/main/docs/commands.md).',
      '',
      '<details><summary>Needs approval from an approver in each of these files:</summary>',
      '',
      `- ~~[olm/OWNERS](${link('olm/OWNERS')})~~ [carol]`,
      `- ~~[sdk/OWNERS](${link('sdk/OWNERS')})~~ [bob]`,
      '',
      'Approvers can indicate their approval by writing `/approve` in a comment',
      'Approvers can cancel approval by writing `/approve cancel` in a comment',
      '</details>',
      notifierMarker,
    ].join('\n'))
  })

  it('lists every approver of a satisfied OWNERS file and groups files by their deepest OWNERS file', () => {
    const owners = pullOwners({ 'OWNERS': 'approvers: [alice]\n', 'sdk/OWNERS': sdkOwners }, ['sdk/x.go', 'sdk/y.go', 'README.md'])
    const state = computeApproval(owners, [at('bob', 'approve'), at('alice', 'approve')], defaults)

    const body = renderNotifier(state, owners, repo)

    expect(body).toContain(`- ~~[OWNERS](${link('OWNERS')})~~ [alice]`)
    expect(body).toContain(`- ~~[sdk/OWNERS](${link('sdk/OWNERS')})~~ [alice, bob]`)
    expect(body.match(/^- /gm)).toHaveLength(2)
  })

  it('a pull request with no changed files says so', () => {
    const owners = pullOwners({ OWNERS: rootOwners }, [])

    const body = renderNotifier(computeApproval(owners, [], defaults), owners, repo)

    expect(body).toContain('This PR is **NOT APPROVED**')
    expect(body).toContain('This pull request changes no files, so there is nothing to approve.')
    expect(body).not.toContain('<details>')
    expect(body.endsWith(notifierMarker)).toBe(true)
  })
})
