import * as core from '@actions/core'
import { describe, expect, it, vi } from 'vitest'

import { defaultAuthorization, defaultHoldLabel, mergeProwConfig, parseProwConfig, resolveAuthorization, resolveHoldLabel, resolveTide } from '../../src/utils/config'

const legacy = `
area:
  - bug
  - important

labels:
  - documentation
  - question

triage:
  values:
    - accepted
    - needs-information
  exclusive: true
`

const modern = `
labels:
  kind:
    - cleanup
    - { name: bug, color: d73a4a, description: Something is broken }
  labels:
    - documentation
  priority:
    values: [low, high]
    exclusive: true

require_matching_label:
  - regexp: ^kind/
    missing_label: needs-kind
    issues: true
    missing_comment: Please add a kind label.
  - regexp: ^area/
    missing_label: needs-area
    grace_period_duration: 5m

tide:
  labels: [lgtm, approved]
  missing_labels: [do-not-merge/hold]
  merge_method: squash

hold:
  label: do-not-merge/hold

approve:
  require_self_approval: true
  lgtm_acts_as_approve: true
`

describe('parseProwConfig', () => {
  it('parses a legacy .prowlabels.yaml as the labels map', () => {
    expect(parseProwConfig('legacy', legacy)).toEqual({
      labels: {
        area: { values: ['bug', 'important'], definitions: [{ name: 'bug' }, { name: 'important' }] },
        labels: { values: ['documentation', 'question'], definitions: [{ name: 'documentation' }, { name: 'question' }] },
        triage: {
          values: ['accepted', 'needs-information'],
          exclusive: true,
          definitions: [{ name: 'accepted' }, { name: 'needs-information' }],
        },
      },
    })
  })

  it('parses the new form with every section', () => {
    expect(parseProwConfig('prow.yaml', modern)).toEqual({
      labels: {
        kind: {
          values: ['cleanup', 'bug'],
          definitions: [{ name: 'cleanup' }, { name: 'bug', color: 'd73a4a', description: 'Something is broken' }],
        },
        labels: { values: ['documentation'], definitions: [{ name: 'documentation' }] },
        priority: { values: ['low', 'high'], exclusive: true, definitions: [{ name: 'low' }, { name: 'high' }] },
      },
      require_matching_label: [
        { regexp: '^kind/', missing_label: 'needs-kind', issues: true, missing_comment: 'Please add a kind label.' },
        { regexp: '^area/', missing_label: 'needs-area', issues: true, prs: true, grace_period_duration: '5m' },
      ],
      tide: { labels: ['lgtm', 'approved'], missing_labels: ['do-not-merge/hold'], merge_method: 'squash' },
      hold: { label: 'do-not-merge/hold' },
      approve: { require_self_approval: true, lgtm_acts_as_approve: true },
    })
  })

  describe('labels list vs mapping disambiguation', () => {
    it('a top level labels list is the legacy /label allowlist', () => {
      expect(parseProwConfig('x', 'labels:\n  - documentation\nkind:\n  - bug\n')).toEqual({
        labels: {
          labels: { values: ['documentation'], definitions: [{ name: 'documentation' }] },
          kind: { values: ['bug'], definitions: [{ name: 'bug' }] },
        },
      })
    })

    it('a top level labels mapping is the new form and its labels key is the /label allowlist', () => {
      expect(parseProwConfig('x', 'labels:\n  labels:\n    - documentation\n')).toEqual({
        labels: {
          labels: { values: ['documentation'], definitions: [{ name: 'documentation' }] },
        },
      })
    })

    it('a document with only reserved keys and no labels is the new form', () => {
      expect(parseProwConfig('x', 'tide:\n  merge_method: rebase\n')).toEqual({
        tide: { merge_method: 'rebase' },
      })
    })

    it('a legacy document may still use tide as a label section when labels is a list', () => {
      expect(parseProwConfig('x', 'labels: [a]\ntide: [b]\n')).toEqual({
        labels: {
          labels: { values: ['a'], definitions: [{ name: 'a' }] },
          tide: { values: ['b'], definitions: [{ name: 'b' }] },
        },
      })
    })

    it('in the new form a section named after a reserved key is nested under labels', () => {
      expect(parseProwConfig('x', 'labels:\n  tide: [b]\nhold:\n  label: hold\n')).toEqual({
        labels: { tide: { values: ['b'], definitions: [{ name: 'b' }] } },
        hold: { label: 'hold' },
      })
    })
  })

  describe('label values', () => {
    it('accepts objects with color and description in a mapping form section', () => {
      const text = 'kind:\n  values:\n    - name: bug\n      color: FF0000\n    - cleanup\n  exclusive: false\n'
      expect(parseProwConfig('x', text)).toEqual({
        labels: {
          kind: {
            values: ['bug', 'cleanup'],
            exclusive: false,
            definitions: [{ name: 'bug', color: 'FF0000' }, { name: 'cleanup' }],
          },
        },
      })
    })

    it('rejects a color that is not six hex digits', () => {
      expect(() => parseProwConfig('x', 'kind:\n  - { name: bug, color: "#d73a4a" }\n')).toThrow(
        `kind: invalid color '#d73a4a' for label 'bug', expected 6 hex digits`,
      )
    })

    it.each([
      ['a scalar', 'level: sandbox\n'],
      ['a mapping without values', 'level:\n  exclusive: true\n'],
      ['a non-boolean exclusive', 'level:\n  values: [sandbox]\n  exclusive: yes please\n'],
      ['nested lists', 'level:\n  - [sandbox]\n'],
      ['an object without a name', 'level:\n  - { color: d73a4a }\n'],
      ['a non-string description', 'level:\n  - { name: a, description: 1 }\n'],
    ])('rejects %s section with the existing error', (_, text) => {
      expect(() => parseProwConfig('x', text)).toThrow(
        `level: yaml malformed, expected a list of values or { values: [...], exclusive: bool }`,
      )
    })

    it('reports a malformed section inside the new form labels mapping', () => {
      expect(() => parseProwConfig('x', 'labels:\n  kind: bug\n')).toThrow(
        `kind: yaml malformed, expected a list of values or { values: [...], exclusive: bool }`,
      )
    })
  })

  describe('require_matching_label', () => {
    it('defaults issues and prs to true when neither is given', () => {
      expect(parseProwConfig('x', 'require_matching_label:\n  - regexp: ^kind/\n    missing_label: needs-kind\n')).toEqual({
        require_matching_label: [{ regexp: '^kind/', missing_label: 'needs-kind', issues: true, prs: true }],
      })
    })

    it('keeps an explicit single flag without defaulting the other', () => {
      expect(parseProwConfig('x', 'require_matching_label:\n  - regexp: ^kind/\n    missing_label: needs-kind\n    prs: true\n')).toEqual({
        require_matching_label: [{ regexp: '^kind/', missing_label: 'needs-kind', prs: true }],
      })
    })

    it.each([
      ['a non-list', 'require_matching_label:\n  regexp: ^kind/\n', 'x: require_matching_label must be a list'],
      ['a scalar entry', 'require_matching_label:\n  - nope\n', 'x: require_matching_label[0]: expected a mapping with regexp and missing_label'],
      ['a missing regexp', 'require_matching_label:\n  - missing_label: a\n', 'x: require_matching_label[0]: regexp must be a string'],
      ['a regexp that does not compile', 'require_matching_label:\n  - regexp: "("\n    missing_label: a\n', 'x: require_matching_label[0]: regexp does not compile'],
      ['an empty missing_label', 'require_matching_label:\n  - regexp: a\n    missing_label: ""\n', 'x: require_matching_label[0]: missing_label must be a non-empty string'],
      ['a non-boolean issues', 'require_matching_label:\n  - regexp: a\n    missing_label: b\n    issues: yes please\n', 'x: require_matching_label[0]: issues must be a boolean'],
      ['a non-string missing_comment', 'require_matching_label:\n  - regexp: a\n    missing_label: b\n    missing_comment: 1\n', 'x: require_matching_label[0]: missing_comment must be a string'],
    ])('rejects %s', (_, text, error) => {
      expect(() => parseProwConfig('x', text)).toThrow(error)
    })
  })

  describe('tide', () => {
    it('accepts label lists and a merge method', () => {
      expect(parseProwConfig('x', 'tide:\n  labels: [lgtm]\n  merge_method: merge\n')).toEqual({
        tide: { labels: ['lgtm'], merge_method: 'merge' },
      })
    })

    it('accepts merge_on_events', () => {
      expect(parseProwConfig('x', 'tide:\n  merge_on_events: false\n')).toEqual({
        tide: { merge_on_events: false },
      })
    })

    it('accepts merge_queue auto and off, and defaults it to auto', () => {
      expect(parseProwConfig('x', 'tide:\n  merge_queue: off\n')).toEqual({ tide: { merge_queue: 'off' } })
      expect(parseProwConfig('x', 'tide:\n  merge_queue: auto\n')).toEqual({ tide: { merge_queue: 'auto' } })
      expect(resolveTide({}).merge_queue).toBe('auto')
      expect(resolveTide({ merge_queue: 'off' }).merge_queue).toBe('off')
    })

    it.each([
      ['a non-mapping', 'tide: [lgtm]\n', 'x: tide must be a mapping'],
      ['a non-list labels', 'tide:\n  labels: lgtm\n', 'x: tide.labels must be a list of label names'],
      ['a non-list missing_labels', 'tide:\n  missing_labels: [1]\n', 'x: tide.missing_labels must be a list of label names'],
      ['an empty label name', 'tide:\n  labels: [lgtm, ""]\n', 'x: tide.labels must be a list of label names'],
      ['an unknown merge method', 'tide:\n  merge_method: fast-forward\n', 'x: tide.merge_method must be one of merge, squash, rebase'],
      ['a non-boolean merge_on_events', 'tide:\n  merge_on_events: yes please\n', 'x: tide.merge_on_events must be a boolean'],
      ['an unknown merge_queue', 'tide:\n  merge_queue: always\n', 'x: tide.merge_queue must be one of auto, off'],
    ])('rejects %s', (_, text, error) => {
      expect(() => parseProwConfig('x', text)).toThrow(error)
    })

    it('accepts glob patterns in the label lists', () => {
      expect(parseProwConfig('x', 'tide:\n  missing_labels: ["do-not-merge/*", "needs-*"]\n')).toEqual({
        tide: { missing_labels: ['do-not-merge/*', 'needs-*'] },
      })
    })
  })

  describe('hold', () => {
    it('accepts a label name', () => {
      expect(parseProwConfig('x', 'hold:\n  label: do-not-merge/hold\n')).toEqual({
        hold: { label: 'do-not-merge/hold' },
      })
    })

    it('accepts an empty mapping', () => {
      expect(parseProwConfig('x', 'hold: {}\n')).toEqual({ hold: {} })
    })

    it('resolves to do-not-merge/hold unless configured', () => {
      expect(defaultHoldLabel).toBe('do-not-merge/hold')
      expect(resolveHoldLabel({})).toBe('do-not-merge/hold')
      expect(resolveHoldLabel({ label: 'hold' })).toBe('hold')
    })

    it.each([
      ['a non-mapping', 'hold: hold\n', 'x: hold must be a mapping'],
      ['an empty label', 'hold:\n  label: ""\n', 'x: hold.label must be a non-empty string'],
    ])('rejects %s', (_, text, error) => {
      expect(() => parseProwConfig('x', text)).toThrow(error)
    })
  })

  describe('blunderbuss', () => {
    it('accepts every field', () => {
      expect(parseProwConfig('x', [
        'blunderbuss:',
        '  request_count: 1',
        '  max_request_count: 3',
        '  exclude_approvers: true',
        '  ignore_drafts: false',
        '  ignore_authors: [\'dependabot[bot]\', renovate]',
      ].join('\n'))).toEqual({
        blunderbuss: {
          request_count: 1,
          max_request_count: 3,
          exclude_approvers: true,
          ignore_drafts: false,
          ignore_authors: ['dependabot[bot]', 'renovate'],
        },
      })
    })

    it('accepts an empty mapping and a max_request_count equal to request_count', () => {
      expect(parseProwConfig('x', 'blunderbuss: {}\n')).toEqual({ blunderbuss: {} })
      expect(parseProwConfig('x', 'blunderbuss:\n  request_count: 2\n  max_request_count: 2\n')).toEqual({
        blunderbuss: { request_count: 2, max_request_count: 2 },
      })
    })

    it.each([
      ['a non-mapping', 'blunderbuss: 2\n', 'x: blunderbuss must be a mapping'],
      ['a zero request_count', 'blunderbuss:\n  request_count: 0\n', 'x: blunderbuss.request_count must be an integer of at least 1'],
      ['a fractional request_count', 'blunderbuss:\n  request_count: 1.5\n', 'x: blunderbuss.request_count must be an integer of at least 1'],
      ['a string request_count', 'blunderbuss:\n  request_count: two\n', 'x: blunderbuss.request_count must be an integer of at least 1'],
      ['a zero max_request_count', 'blunderbuss:\n  max_request_count: 0\n', 'x: blunderbuss.max_request_count must be an integer of at least 1'],
      ['a max_request_count below request_count', 'blunderbuss:\n  request_count: 3\n  max_request_count: 2\n', 'x: blunderbuss.max_request_count must not be lower than request_count'],
      ['a non-boolean exclude_approvers', 'blunderbuss:\n  exclude_approvers: yes please\n', 'x: blunderbuss.exclude_approvers must be a boolean'],
      ['a non-boolean ignore_drafts', 'blunderbuss:\n  ignore_drafts: 1\n', 'x: blunderbuss.ignore_drafts must be a boolean'],
      ['a non-list ignore_authors', 'blunderbuss:\n  ignore_authors: bot\n', 'x: blunderbuss.ignore_authors must be a list of GitHub usernames'],
    ])('rejects %s', (_, text, error) => {
      expect(() => parseProwConfig('x', text)).toThrow(error)
    })

    it('marks a document as the new form on its own', () => {
      expect(parseProwConfig('x', 'blunderbuss:\n  request_count: 1\n')).toEqual({ blunderbuss: { request_count: 1 } })
    })
  })

  describe('approve', () => {
    it('accepts every flag', () => {
      expect(parseProwConfig('x', 'approve:\n  require_self_approval: true\n  ignore_review_state: true\n  lgtm_acts_as_approve: false\n  github_review: true\n')).toEqual({
        approve: { require_self_approval: true, ignore_review_state: true, lgtm_acts_as_approve: false, github_review: true },
      })
    })

    it('accepts an empty mapping and marks the document as the new form on its own', () => {
      expect(parseProwConfig('x', 'approve: {}\n')).toEqual({ approve: {} })
    })

    it.each([
      ['a non-mapping', 'approve: true\n', 'x: approve must be a mapping'],
      ['a non-boolean require_self_approval', 'approve:\n  require_self_approval: yes please\n', 'x: approve.require_self_approval must be a boolean'],
      ['a non-boolean ignore_review_state', 'approve:\n  ignore_review_state: 1\n', 'x: approve.ignore_review_state must be a boolean'],
      ['a non-boolean lgtm_acts_as_approve', 'approve:\n  lgtm_acts_as_approve: [true]\n', 'x: approve.lgtm_acts_as_approve must be a boolean'],
      ['a non-boolean github_review', 'approve:\n  github_review: \'true\'\n', 'x: approve.github_review must be a boolean'],
    ])('rejects %s', (_, text, error) => {
      expect(() => parseProwConfig('x', text)).toThrow(error)
    })
  })

  describe('lgtm', () => {
    it('accepts bind_to_commit and marks the document as the new form on its own', () => {
      expect(parseProwConfig('x', 'lgtm:\n  bind_to_commit: false\n')).toEqual({ lgtm: { bind_to_commit: false } })
      expect(parseProwConfig('x', 'lgtm: {}\n')).toEqual({ lgtm: {} })
    })

    it.each([
      ['a non-mapping', 'lgtm: true\n', 'x: lgtm must be a mapping'],
      ['a non-boolean bind_to_commit', 'lgtm:\n  bind_to_commit: yes please\n', 'x: lgtm.bind_to_commit must be a boolean'],
    ])('rejects %s', (_, text, error) => {
      expect(() => parseProwConfig('x', text)).toThrow(error)
    })
  })

  describe('authorization', () => {
    it('accepts every key and marks the document as the new form on its own', () => {
      expect(parseProwConfig('x', [
        'authorization:',
        '  labels: trusted',
        '  hold: members',
        '  close: anyone',
        '  review: trusted',
        '  users: [Alice, bob]',
      ].join('\n'))).toEqual({
        authorization: { labels: 'trusted', hold: 'members', close: 'anyone', review: 'trusted', users: ['Alice', 'bob'] },
      })
      expect(parseProwConfig('x', 'authorization: {}\n')).toEqual({ authorization: {} })
    })

    it('is a reserved key, never a label section of a legacy document', () => {
      expect(parseProwConfig('x', 'authorization:\n  labels: collaborators\n').labels).toBeUndefined()
    })

    it.each(['anyone', 'collaborators', 'members', 'trusted'])('accepts %s for labels, hold and close', (policy) => {
      expect(parseProwConfig('x', `authorization:\n  labels: ${policy}\n  hold: ${policy}\n  close: ${policy}\n`)).toEqual({
        authorization: { labels: policy, hold: policy, close: policy },
      })
    })

    it('resolves to today\'s gates unless configured, with users lower-cased', () => {
      expect(defaultAuthorization).toEqual({ labels: 'anyone', hold: 'anyone', close: 'collaborators', review: 'members', users: [] })
      expect(resolveAuthorization({})).toEqual(defaultAuthorization)
      expect(resolveAuthorization({ labels: 'trusted', users: ['Alice', 'BOB'] })).toEqual({
        labels: 'trusted',
        hold: 'anyone',
        close: 'collaborators',
        review: 'members',
        users: ['alice', 'bob'],
      })
    })

    it.each([
      ['a non-mapping', 'authorization: trusted\n', 'x: authorization must be a mapping'],
      ['an unknown key', 'authorization:\n  lgtm: trusted\n', 'x: authorization.lgtm is not a known key, expected one of labels, hold, close, review, users'],
      ['an unknown labels policy', 'authorization:\n  labels: everyone\n', 'x: authorization.labels must be one of anyone, collaborators, members, trusted'],
      ['an unknown hold policy', 'authorization:\n  hold: true\n', 'x: authorization.hold must be one of anyone, collaborators, members, trusted'],
      ['an unknown close policy', 'authorization:\n  close: [members]\n', 'x: authorization.close must be one of anyone, collaborators, members, trusted'],
      ['review: anyone', 'authorization:\n  review: anyone\n', 'x: authorization.review must be one of members, trusted'],
      ['review: collaborators', 'authorization:\n  review: collaborators\n', 'x: authorization.review must be one of members, trusted'],
      ['users as a string', 'authorization:\n  users: alice\n', 'x: authorization.users must be a list of logins'],
      ['an empty login', 'authorization:\n  users: [alice, ""]\n', 'x: authorization.users must be a list of logins'],
      ['a non-string login', 'authorization:\n  users: [alice, 42]\n', 'x: authorization.users must be a list of logins'],
    ])('rejects %s', (_, text, error) => {
      expect(() => parseProwConfig('x', text)).toThrow(error)
    })
  })

  it('tolerates unknown top level keys in the new form and logs them once', () => {
    const debug = vi.spyOn(core, 'debug')

    expect(parseProwConfig('prow.yaml', 'labels:\n  kind: [bug]\nplugins: [approve]\nowners: {}\n')).toEqual({
      labels: { kind: { values: ['bug'], definitions: [{ name: 'bug' }] } },
    })
    expect(debug).toHaveBeenCalledTimes(1)
    expect(debug).toHaveBeenCalledWith('prow.yaml: ignoring unknown top level keys: plugins, owners')
  })

  it.each([
    ['an empty string', ''],
    ['a document marker only', '---\n'],
    ['whitespace', '  \n\n'],
  ])('treats %s as an all-empty config', (_, text) => {
    expect(parseProwConfig('x', text)).toEqual({})
  })

  it.each([
    ['a list', '- a\n- b\n'],
    ['a scalar', 'just a string\n'],
  ])('rejects %s at the top level', (_, text) => {
    expect(() => parseProwConfig('x', text)).toThrow('x: yaml malformed, expected a mapping at the top level')
  })
})

describe('mergeProwConfig', () => {
  it('replaces label sections per key, concatenates rules and shallow-merges tide, hold, blunderbuss, approve and lgtm', () => {
    const org = parseProwConfig('org', [
      'labels:',
      '  kind: [bug, cleanup]',
      '  area: [api]',
      'require_matching_label:',
      '  - { regexp: ^kind/, missing_label: needs-kind }',
      'tide:',
      '  labels: [lgtm]',
      '  merge_method: merge',
      'hold:',
      '  label: hold',
      'blunderbuss:',
      '  request_count: 1',
      '  ignore_authors: [bot]',
      'approve:',
      '  require_self_approval: true',
      '  lgtm_acts_as_approve: true',
    ].join('\n'))
    const repo = parseProwConfig('repo', [
      'labels:',
      '  kind: [docs]',
      'require_matching_label:',
      '  - { regexp: ^area/, missing_label: needs-area }',
      'tide:',
      '  merge_method: squash',
      'blunderbuss:',
      '  request_count: 3',
      'approve:',
      '  require_self_approval: false',
      'lgtm:',
      '  bind_to_commit: false',
    ].join('\n'))

    expect(mergeProwConfig(org, repo)).toEqual({
      labels: {
        kind: { values: ['docs'], definitions: [{ name: 'docs' }] },
        area: { values: ['api'], definitions: [{ name: 'api' }] },
      },
      require_matching_label: [
        { regexp: '^kind/', missing_label: 'needs-kind', issues: true, prs: true },
        { regexp: '^area/', missing_label: 'needs-area', issues: true, prs: true },
      ],
      tide: { labels: ['lgtm'], merge_method: 'squash' },
      hold: { label: 'hold' },
      blunderbuss: { request_count: 3, ignore_authors: ['bot'] },
      approve: { require_self_approval: false, lgtm_acts_as_approve: true },
      lgtm: { bind_to_commit: false },
      sweep: {},
      authorization: {},
    })
  })

  it('merges authorization per key, repo over org, and unions users without case-insensitive duplicates', () => {
    const org = parseProwConfig('org', 'authorization:\n  labels: trusted\n  hold: trusted\n  review: trusted\n  users: [Alice, bob]\n')
    const repo = parseProwConfig('repo', 'authorization:\n  hold: anyone\n  close: members\n  users: [alice, Carol]\n')

    expect(mergeProwConfig(org, repo).authorization).toEqual({
      labels: 'trusted',
      hold: 'anyone',
      close: 'members',
      review: 'trusted',
      users: ['Alice', 'bob', 'Carol'],
    })
    expect(resolveAuthorization(mergeProwConfig(org, repo).authorization).users).toEqual(['alice', 'bob', 'carol'])
  })

  it('keeps one tier\'s users when the other tier names none', () => {
    const org = parseProwConfig('org', 'authorization:\n  users: [alice, Alice]\n')
    const repo = parseProwConfig('repo', 'authorization:\n  labels: members\n')

    expect(mergeProwConfig(org, repo).authorization).toEqual({ labels: 'members', users: ['alice'] })
    expect(mergeProwConfig(repo, org).authorization).toEqual({ labels: 'members', users: ['alice'] })
    expect(mergeProwConfig(repo, {}).authorization).toEqual({ labels: 'members' })
  })

  it('fills every section when both sides are empty', () => {
    expect(mergeProwConfig({}, {})).toEqual({ labels: {}, require_matching_label: [], tide: {}, hold: {}, blunderbuss: {}, approve: {}, lgtm: {}, sweep: {}, authorization: {} })
  })
})
