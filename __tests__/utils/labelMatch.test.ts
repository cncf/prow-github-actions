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
    ['a*b*c', 'a-b'],
    ['kind/bug', 'kind/bugs'],
    ['kind.bug', 'kindxbug'],
    ['(lgtm)', 'lgtm'],
  ])('%s does not match %s', (pattern, label) => {
    expect(matchesLabelPattern(pattern, label)).toBe(false)
  })
})
