import type { ResolvedTide } from '../../src/utils/config'
import { describe, expect, it } from 'vitest'

import { resolveTide } from '../../src/utils/config'
import { meetsMergeGate } from '../../src/utils/mergeGate'

const defaults: ResolvedTide = resolveTide({})

describe('meetsMergeGate', () => {
  describe('with the default tide configuration', () => {
    it('passes a PR carrying lgtm and nothing blocking', () => {
      expect(meetsMergeGate(['lgtm', 'kind/bug'], defaults)).toEqual({ ok: true })
    })

    it('compares label names case-insensitively', () => {
      expect(meetsMergeGate(['LGTM'], defaults)).toEqual({ ok: true })
    })

    it('reports the missing required label', () => {
      expect(meetsMergeGate(['approved', 'kind/bug'], defaults)).toEqual({ ok: false, reason: 'missing lgtm' })
      expect(meetsMergeGate([], defaults)).toEqual({ ok: false, reason: 'missing lgtm' })
    })

    it.each([
      'do-not-merge/hold',
      'do-not-merge/work-in-progress',
      'do-not-merge/invalid-owners-file',
      'do-not-merge/release-note-label-needed',
      'do-not-merge/contains-merge-commits',
      'do-not-merge/blocked-paths',
      'do-not-merge/cherry-pick-not-approved',
      'do-not-merge/needs-kind',
      'needs-rebase',
      'hold',
      'Hold',
    ])('is blocked by %s', (label) => {
      expect(meetsMergeGate(['lgtm', label], defaults)).toEqual({ ok: false, reason: `blocked by ${label}` })
    })

    it('is not blocked by a bare do-not-merge label or a look-alike', () => {
      expect(meetsMergeGate(['lgtm', 'do-not-merge'], defaults)).toEqual({ ok: true })
      expect(meetsMergeGate(['lgtm', 'holdover', 'needs-kind'], defaults)).toEqual({ ok: true })
    })

    it('reports the missing label before the blocking one', () => {
      expect(meetsMergeGate(['do-not-merge/hold'], defaults)).toEqual({ ok: false, reason: 'missing lgtm' })
    })
  })

  describe('with a configured tide section', () => {
    it('requires every label pattern', () => {
      const tide = resolveTide({ labels: ['lgtm', 'approved'] })

      expect(meetsMergeGate(['lgtm'], tide)).toEqual({ ok: false, reason: 'missing approved' })
      expect(meetsMergeGate(['lgtm', 'approved'], tide)).toEqual({ ok: true })
    })

    it('a configured missing_labels list replaces the default list entirely', () => {
      const tide = resolveTide({ missing_labels: ['needs-rebase'] })

      expect(meetsMergeGate(['lgtm', 'hold', 'do-not-merge/hold'], tide)).toEqual({ ok: true })
      expect(meetsMergeGate(['lgtm', 'needs-rebase'], tide)).toEqual({ ok: false, reason: 'blocked by needs-rebase' })
    })

    it('an empty missing_labels list blocks nothing', () => {
      expect(meetsMergeGate(['lgtm', 'do-not-merge/hold'], resolveTide({ missing_labels: [] }))).toEqual({ ok: true })
    })

    it('a glob in labels is satisfied by any matching label', () => {
      expect(meetsMergeGate(['lgtm', 'approved-by/alice'], resolveTide({ labels: ['lgtm', 'approved-by/*'] }))).toEqual({ ok: true })
    })
  })
})

describe('resolveTide', () => {
  it('fills the defaults: lgtm required, the do-not-merge family, needs-rebase and hold blocking, merge method merge', () => {
    expect(resolveTide({})).toEqual({
      labels: ['lgtm'],
      missing_labels: ['do-not-merge/*', 'needs-rebase', 'hold'],
      merge_method: 'merge',
    })
  })

  it('a configured merge_method wins over the action input', () => {
    expect(resolveTide({ merge_method: 'squash' }, 'rebase').merge_method).toBe('squash')
  })

  it('falls back to the action input, then to merge for an unknown input', () => {
    expect(resolveTide({}, 'rebase').merge_method).toBe('rebase')
    expect(resolveTide({}, 'squash').merge_method).toBe('squash')
    expect(resolveTide({}, 'fast-forward').merge_method).toBe('merge')
    expect(resolveTide({}, '').merge_method).toBe('merge')
  })

  it('keeps configured label lists as given', () => {
    expect(resolveTide({ labels: ['lgtm', 'approved'], missing_labels: [] })).toEqual({
      labels: ['lgtm', 'approved'],
      missing_labels: [],
      merge_method: 'merge',
    })
  })
})
