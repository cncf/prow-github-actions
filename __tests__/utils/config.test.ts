import * as core from '@actions/core'
import { describe, expect, it, vi } from 'vitest'

import { mergeProwConfig, parseProwConfig } from '../../src/utils/config'

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

    it.each([
      ['a non-mapping', 'tide: [lgtm]\n', 'x: tide must be a mapping'],
      ['a non-list labels', 'tide:\n  labels: lgtm\n', 'x: tide.labels must be a list of label names'],
      ['a non-list missing_labels', 'tide:\n  missing_labels: [1]\n', 'x: tide.missing_labels must be a list of label names'],
      ['an unknown merge method', 'tide:\n  merge_method: fast-forward\n', 'x: tide.merge_method must be one of merge, squash, rebase'],
    ])('rejects %s', (_, text, error) => {
      expect(() => parseProwConfig('x', text)).toThrow(error)
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

    it.each([
      ['a non-mapping', 'hold: hold\n', 'x: hold must be a mapping'],
      ['an empty label', 'hold:\n  label: ""\n', 'x: hold.label must be a non-empty string'],
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
  it('replaces label sections per key, concatenates rules and shallow-merges tide and hold', () => {
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
    ].join('\n'))
    const repo = parseProwConfig('repo', [
      'labels:',
      '  kind: [docs]',
      'require_matching_label:',
      '  - { regexp: ^area/, missing_label: needs-area }',
      'tide:',
      '  merge_method: squash',
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
    })
  })

  it('fills every section when both sides are empty', () => {
    expect(mergeProwConfig({}, {})).toEqual({ labels: {}, require_matching_label: [], tide: {}, hold: {} })
  })
})
