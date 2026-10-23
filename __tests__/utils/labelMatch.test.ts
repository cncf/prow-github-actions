import { describe, expect, it } from 'vitest'

import { matchesLabelPattern } from '../../src/utils/labelMatch'

describe('matchesLabelPattern', () => {
  it.each([
    ['do-not-merge/*', 'do-not-merge/hold'],
    ['do-not-merge/*', 'do-not-merge/x/y'],
    ['do-not-merge/*', 'DO-NOT-MERGE/Hold'],
    ['hold', 'Hold'],
    ['needs-*', 'needs-rebase'],
    ['needs-*', 'needs-'],
    ['*', 'anything/at all'],
    ['*-rebase', 'needs-rebase'],
    ['a*b*c', 'a-x-b-y-c'],
    ['a*b*c', 'abc'],
    ['kind/bug', 'kind/bug'],
  ])('%s matches %s', (pattern, label) => {
    expect(matchesLabelPattern(pattern, label)).toBe(true)
  })

  it.each([
    ['do-not-merge', 'do-not-merge/hold'],
    ['do-not-merge/*', 'do-not-merge'],
    ['hold', 'do-not-merge/hold'],
    ['hold', 'holdover'],
    ['needs-*', 'need-rebase'],
    ['*-rebase', 'needs-approve'],
    ['needs-*-rebase', 'needs-rebase-now'],
    ['a*b*c', 'a-b'],
    ['kind/bug', 'kind/bugs'],
    ['kind.bug', 'kindxbug'],
    ['(lgtm)', 'lgtm'],
  ])('%s does not match %s', (pattern, label) => {
    expect(matchesLabelPattern(pattern, label)).toBe(false)
  })

  it('does not let the anchored ends share characters', () => {
    // the `*` run may be empty, but the prefix and suffix must both fit in full
    expect(matchesLabelPattern('do-not-merge/*/hold', 'do-not-merge/hold')).toBe(false)
    expect(matchesLabelPattern('do-not-merge/*/hold', 'do-not-merge//hold')).toBe(true)
  })

  it('does not let a middle part reuse characters of the part before it', () => {
    // each middle part is searched for only after the end of the previous match
    expect(matchesLabelPattern('*ab*b*', 'ab')).toBe(false)
    expect(matchesLabelPattern('*ab*b*', 'abb')).toBe(true)
    expect(matchesLabelPattern('x*ab*b*y', 'xaby')).toBe(false)
    expect(matchesLabelPattern('x*ab*b*y', 'xabby')).toBe(true)
  })
})
