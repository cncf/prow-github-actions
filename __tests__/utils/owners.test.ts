import * as core from '@actions/core'
import { describe, expect, it, vi } from 'vitest'

import {
  effectiveOwners,
  ownersDir,
  parseOwners,
} from '../../src/utils/owners'

describe('parseOwners', () => {
  it('reads approvers and reviewers', () => {
    const owners = parseOwners('OWNERS', 'approvers:\n- alice\nreviewers:\n- bob\n- carol\n')

    expect(owners).toEqual({
      path: 'OWNERS',
      approvers: ['alice'],
      reviewers: ['bob', 'carol'],
      noParentOwners: false,
    })
  })

  it('defaults a missing role to an empty list', () => {
    const owners = parseOwners('OWNERS', 'approvers:\n- alice\n')

    expect(owners.reviewers).toEqual([])
  })

  it('treats an empty role and an empty file as no members', () => {
    expect(parseOwners('OWNERS', 'approvers:\n').approvers).toEqual([])
    expect(parseOwners('OWNERS', '')).toMatchObject({ approvers: [], reviewers: [] })
  })

  it('lowercases logins', () => {
    const owners = parseOwners('OWNERS', 'approvers:\n- Alice\nreviewers:\n- BOB\n')

    expect(owners.approvers).toEqual(['alice'])
    expect(owners.reviewers).toEqual(['bob'])
  })

  it('ignores emeritus roles and unknown keys', () => {
    const owners = parseOwners(
      'OWNERS',
      [
        'approvers:',
        '- alice',
        'emeritus_approvers:',
        '- zed',
        'emeritus_reviewers:',
        '- yan',
        'labels:',
        '- sig/foo',
        'something_else: 42',
      ].join('\n'),
    )

    expect(owners.approvers).toEqual(['alice'])
    expect(owners.reviewers).toEqual([])
  })

  it('notes that filters are ignored', () => {
    const debug = vi.spyOn(core, 'debug')

    const owners = parseOwners(
      'sdk/OWNERS',
      'approvers:\n- alice\nfilters:\n  ".*":\n    approvers:\n    - bob\n',
    )

    expect(owners.approvers).toEqual(['alice'])
    expect(debug).toHaveBeenCalledWith(
      'OWNERS at sdk/OWNERS: filters are not supported; ignoring',
    )
  })

  it('reads options.no_parent_owners', () => {
    expect(
      parseOwners('olm/OWNERS', 'options:\n  no_parent_owners: true\napprovers:\n- carol\n').noParentOwners,
    ).toBe(true)
    expect(
      parseOwners('olm/OWNERS', 'options:\n  no_parent_owners: false\n').noParentOwners,
    ).toBe(false)
    expect(
      parseOwners('olm/OWNERS', 'options: {}\n').noParentOwners,
    ).toBe(false)
  })

  it.each([
    ['approvers: alice\n', 'approvers'],
    ['reviewers:\n  alice: true\n', 'reviewers'],
    ['approvers:\n- alice\n- 7\n', 'approvers'],
  ])('rejects a role that is not a list of strings: %j', (contents, role) => {
    expect(() => parseOwners('sdk/OWNERS', contents)).toThrow(
      `OWNERS at sdk/OWNERS: ${role} must be a list of GitHub usernames`,
    )
  })

  it('treats a non-mapping document as empty', () => {
    expect(parseOwners('OWNERS', '- alice\n')).toMatchObject({ approvers: [], reviewers: [] })
    expect(parseOwners('OWNERS', 'just text\n')).toMatchObject({ approvers: [], reviewers: [] })
  })
})

describe('ownersDir', () => {
  it.each([
    ['OWNERS', ''],
    ['sdk/OWNERS', 'sdk'],
    ['a/b/c/OWNERS', 'a/b/c'],
    ['README.md', ''],
    ['sdk/x.go', 'sdk'],
    ['sdk', ''],
  ])('%s -> %j', (path, dir) => {
    expect(ownersDir(path)).toBe(dir)
  })
})

describe('effectiveOwners', () => {
  const root = parseOwners('OWNERS', 'approvers:\n- alice\nreviewers:\n- rita\n')
  const sdk = parseOwners('sdk/OWNERS', 'approvers:\n- bob\nreviewers:\n- ryan\n')
  const olm = parseOwners('olm/OWNERS', 'options:\n  no_parent_owners: true\napprovers:\n- carol\n')
  const deep = parseOwners('sdk/internal/OWNERS', 'approvers:\n- dave\n')

  it('unions the file with its parents, nearest first', () => {
    const owners = new Map([['', root], ['sdk', sdk], ['sdk/internal', deep]])

    const set = effectiveOwners('sdk/internal/x.go', owners)

    expect(set).toBeDefined()
    expect([...set!.approvers]).toEqual(['dave', 'bob', 'alice'])
    expect([...set!.reviewers]).toEqual(['ryan', 'rita'])
    expect(set!.sources).toEqual(['sdk/internal/OWNERS', 'sdk/OWNERS', 'OWNERS'])
  })

  it('does not apply a sibling directory', () => {
    const owners = new Map([['', root], ['sdk', sdk]])

    const set = effectiveOwners('docs/x.md', owners)

    expect([...set!.approvers]).toEqual(['alice'])
    expect(set!.sources).toEqual(['OWNERS'])
  })

  it('stops at a file with no_parent_owners', () => {
    const owners = new Map([['', root], ['olm', olm]])

    const set = effectiveOwners('olm/y.go', owners)

    expect([...set!.approvers]).toEqual(['carol'])
    expect([...set!.reviewers]).toEqual([])
    expect(set!.sources).toEqual(['olm/OWNERS'])
  })

  it('is undefined when no OWNERS covers the file', () => {
    const owners = new Map([['sdk', sdk]])

    expect(effectiveOwners('README.md', owners)).toBeUndefined()
    expect(effectiveOwners('docs/x.md', owners)).toBeUndefined()
  })

  it('lets a root-only OWNERS cover a deep path', () => {
    const owners = new Map([['', root]])

    const set = effectiveOwners('a/b/c/d.txt', owners)

    expect([...set!.approvers]).toEqual(['alice'])
    expect(set!.sources).toEqual(['OWNERS'])
  })

  it('is undefined for an empty map', () => {
    expect(effectiveOwners('README.md', new Map())).toBeUndefined()
  })
})
