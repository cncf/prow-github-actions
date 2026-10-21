import * as core from '@actions/core'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
  effectiveOwners,
  expandGroups,
  expandOwnersSet,
  ownersDir,
  ownersInclude,
  parseGroup,
  parseOwners,
  resetOwnersCaches,
} from '../../src/utils/owners'

describe('parseOwners', () => {
  it('reads approvers and reviewers', () => {
    const owners = parseOwners('OWNERS', 'approvers:\n- alice\nreviewers:\n- bob\n- carol\n')

    expect(owners).toEqual({
      path: 'OWNERS',
      approvers: ['alice'],
      reviewers: ['bob', 'carol'],
      labels: [],
      noParentOwners: false,
    })
  })

  it('reads labels verbatim and defaults them to an empty list', () => {
    expect(parseOwners('sdk/OWNERS', 'reviewers:\n- bob\nlabels:\n- area/SDK\n- kind/cleanup\n').labels).toEqual(['area/SDK', 'kind/cleanup'])
    expect(parseOwners('sdk/OWNERS', 'reviewers:\n- bob\n').labels).toEqual([])
    expect(parseOwners('sdk/OWNERS', 'labels:\n').labels).toEqual([])
  })

  it.each([
    'labels: area/sdk\n',
    'labels:\n  area/sdk: true\n',
    'labels:\n- area/sdk\n- 7\n',
  ])('rejects labels that are not a list of strings: %j', (contents) => {
    expect(() => parseOwners('sdk/OWNERS', contents)).toThrow(
      'OWNERS at sdk/OWNERS: labels must be a list of label names',
    )
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
  const root = parseOwners('OWNERS', 'approvers:\n- alice\nreviewers:\n- rita\nlabels:\n- kind/root\n')
  const sdk = parseOwners('sdk/OWNERS', 'approvers:\n- bob\nreviewers:\n- ryan\nlabels:\n- area/sdk\n')
  const olm = parseOwners('olm/OWNERS', 'options:\n  no_parent_owners: true\napprovers:\n- carol\nlabels:\n- area/olm\n')
  const deep = parseOwners('sdk/internal/OWNERS', 'approvers:\n- dave\nlabels:\n- area/sdk\n- area/internal\n')

  it('unions the file with its parents, nearest first', () => {
    const owners = new Map([['', root], ['sdk', sdk], ['sdk/internal', deep]])

    const set = effectiveOwners('sdk/internal/x.go', owners)

    expect(set).toBeDefined()
    expect([...set!.approvers]).toEqual(['dave', 'bob', 'alice'])
    expect([...set!.reviewers]).toEqual(['ryan', 'rita'])
    expect([...set!.labels]).toEqual(['area/sdk', 'area/internal', 'kind/root'])
    expect(set!.sources).toEqual(['sdk/internal/OWNERS', 'sdk/OWNERS', 'OWNERS'])
  })

  it('does not apply a sibling directory', () => {
    const owners = new Map([['', root], ['sdk', sdk]])

    const set = effectiveOwners('docs/x.md', owners)

    expect([...set!.approvers]).toEqual(['alice'])
    expect([...set!.labels]).toEqual(['kind/root'])
    expect(set!.sources).toEqual(['OWNERS'])
  })

  it('stops at a file with no_parent_owners', () => {
    const owners = new Map([['', root], ['olm', olm]])

    const set = effectiveOwners('olm/y.go', owners)

    expect([...set!.approvers]).toEqual(['carol'])
    expect([...set!.reviewers]).toEqual([])
    expect([...set!.labels]).toEqual(['area/olm'])
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

describe('parseGroup', () => {
  it('splits @org/team-slug into its org and slug', () => {
    expect(parseGroup('@myorg/maintainers')).toEqual({ org: 'myorg', slug: 'maintainers' })
    expect(parseGroup('@my-org/team.1')).toEqual({ org: 'my-org', slug: 'team.1' })
  })

  it.each([
    ['alice', 'a plain login'],
    ['@bob', 'an @ without a slash'],
    ['@myorg/a/b', 'a third path segment'],
    ['@myorg/', 'an empty slug'],
    ['@/team', 'an empty org'],
    ['@my org/team', 'whitespace in the org'],
    ['@myorg/te am', 'whitespace in the slug'],
  ])('is undefined for %s (%s)', (entry) => {
    expect(parseGroup(entry)).toBeUndefined()
  })
})

describe('expandGroups', () => {
  const context = { repo: { owner: 'MyOrg', repo: 'r' } } as never

  function client(listed: Record<string, string[]>) {
    const paginate = vi.fn(async (_fn: unknown, params: { team_slug: string }) => {
      const members = listed[params.team_slug]
      if (members === undefined) {
        throw new Error('404')
      }
      return members.map(login => ({ login }))
    })
    return { paginate, teams: { listMembersInOrg: vi.fn() } } as never
  }

  it('replaces same-org groups with their members and keeps plain logins', async () => {
    const result = await expandGroups(client({ maintainers: ['Bob', 'carol'] }), context, ['alice', '@myorg/maintainers'])

    expect([...result].sort()).toEqual(['alice', 'bob', 'carol'])
  })

  beforeEach(() => resetOwnersCaches())

  it('ignores groups of another org and groups it cannot read', async () => {
    const result = await expandGroups(client({}), context, ['alice', '@other/team', '@myorg/missing'])

    expect([...result]).toEqual(['alice'])
    expect(core.warning).toHaveBeenCalledTimes(2)
  })

  it('drops an @ entry that is not @org/team-slug, with a warning', async () => {
    const result = await expandGroups(client({}), context, ['alice', '@bob', '@myorg/a/b'])

    expect([...result]).toEqual(['alice'])
    expect(core.warning).toHaveBeenCalledTimes(2)
    expect(core.warning).toHaveBeenCalledWith('OWNERS: ignoring @bob: a group is written @<org>/<team-slug>')
    // not reported as a group of org "myorg/a": the extra segment makes it malformed, not foreign
    expect(core.warning).toHaveBeenCalledWith('OWNERS: ignoring @myorg/a/b: a group is written @<org>/<team-slug>')
  })

  it('warns once per entry per run, however many files list it', async () => {
    const octokit = client({})
    await expandGroups(octokit, context, ['@other/team', '@myorg/missing'])
    await expandGroups(octokit, context, ['@other/team', '@myorg/missing'])
    await expandGroups(octokit, context, ['@other/team'])

    expect(core.warning).toHaveBeenCalledTimes(2)
    expect((octokit as { paginate: ReturnType<typeof vi.fn> }).paginate).toHaveBeenCalledTimes(1)
  })

  it('reads each team once per run', async () => {
    const octokit = client({ maintainers: ['bob'] })
    const [a, b] = await Promise.all([
      expandGroups(octokit, context, ['@myorg/maintainers']),
      expandGroups(octokit, context, ['@myorg/maintainers', 'alice']),
    ])

    expect([...a]).toEqual(['bob'])
    expect([...b].sort()).toEqual(['alice', 'bob'])
    expect((octokit as { paginate: ReturnType<typeof vi.fn> }).paginate).toHaveBeenCalledTimes(1)
  })
})

describe('expandOwnersSet', () => {
  const context = { repo: { owner: 'myorg', repo: 'r' } } as never
  const octokit = {
    paginate: vi.fn(async () => [{ login: 'Bob' }]),
    teams: { listMembersInOrg: vi.fn() },
  } as never

  it('expands both roles and keeps labels and sources', async () => {
    const set = await expandOwnersSet(octokit, context, {
      approvers: new Set(['@myorg/maintainers']),
      reviewers: new Set(['alice', '@myorg/maintainers']),
      labels: new Set(['area/sdk']),
      sources: ['sdk/OWNERS'],
    })

    expect(set).toEqual({
      approvers: new Set(['bob']),
      reviewers: new Set(['alice', 'bob']),
      labels: new Set(['area/sdk']),
      sources: ['sdk/OWNERS'],
    })
  })

  it('passes undefined through', async () => {
    expect(await expandOwnersSet(octokit, context, undefined)).toBeUndefined()
  })
})

describe('ownersInclude', () => {
  const context = { repo: { owner: 'myorg', repo: 'r' } } as never

  function client(members: string[]) {
    return {
      paginate: vi.fn(async () => members.map(login => ({ login }))),
      teams: { listMembersInOrg: vi.fn() },
    }
  }

  beforeEach(() => resetOwnersCaches())

  it('answers a direct listing without reading any team', async () => {
    const octokit = client(['bob'])

    expect(await ownersInclude(octokit as never, context, ['alice', '@myorg/maintainers'], 'alice')).toBe(true)
    expect(octokit.paginate).not.toHaveBeenCalled()
  })

  it('reads the teams when the login is not listed directly', async () => {
    const octokit = client(['bob'])

    expect(await ownersInclude(octokit as never, context, ['alice', '@myorg/maintainers'], 'bob')).toBe(true)
    expect(await ownersInclude(octokit as never, context, ['alice', '@myorg/maintainers'], 'carol')).toBe(false)
    expect(octokit.paginate).toHaveBeenCalledTimes(1)
  })
})
