import type { ProwConfig } from '../../src/utils/config'
import { describe, expect, it } from 'vitest'

import { mergeProwConfig, parseProwConfig } from '../../src/utils/config'
import { builtinLabelDefaults, desiredLabels } from '../../src/utils/labelCatalog'

function configFrom(yaml: string): ProwConfig {
  return { ...mergeProwConfig({}, parseProwConfig('test', yaml)), sources: ['test'] }
}

const registryDefaults = [
  'lifecycle/frozen',
  'lifecycle/rotten',
  'lifecycle/stale',
  'stage/alpha',
  'stage/beta',
  'stage/stable',
  'status/approved-for-milestone',
  'status/in-progress',
  'status/in-review',
]

const actionManaged = ['approved', 'good first issue', 'help wanted', 'hold', 'lgtm']

function names(config: ProwConfig): string[] {
  return desiredLabels(config).map(label => label.name)
}

describe('desiredLabels', () => {
  it('yields the built-ins and the action-managed labels for an empty configuration', () => {
    expect(names(configFrom(''))).toEqual([...actionManaged, ...registryDefaults].sort((a, b) => a.localeCompare(b)))
  })

  it('prefixes section values with the key and carries color and description', () => {
    const labels = desiredLabels(configFrom(`
labels:
  kind:
    - name: bug
      color: D73A4A
      description: Something is not working
    - cleanup
  area: [api]
`))

    expect(labels.filter(l => l.name.startsWith('kind/') || l.name.startsWith('area/'))).toEqual([
      { name: 'area/api' },
      { name: 'kind/bug', color: 'd73a4a', description: 'Something is not working' },
      { name: 'kind/cleanup' },
    ])
  })

  it('applies the /label allowlist verbatim', () => {
    const result = names(configFrom('labels:\n  labels: [documentation, question]\n'))

    expect(result).toContain('documentation')
    expect(result).toContain('question')
    expect(result.some(name => name.startsWith('labels/'))).toBe(false)
  })

  it('treats a legacy flat document the same way', () => {
    const result = names(configFrom('kind: [bug]\nlabels: [documentation]\n'))

    expect(result).toContain('kind/bug')
    expect(result).toContain('documentation')
  })

  it('a yaml section replaces the registry defaults of its key', () => {
    const result = names(configFrom('labels:\n  lifecycle: [frozen]\n'))

    expect(result).toContain('lifecycle/frozen')
    expect(result).not.toContain('lifecycle/stale')
    expect(result).not.toContain('lifecycle/rotten')
    expect(result).toContain('stage/alpha')
  })

  it('includes dynamic sections outside the registry', () => {
    expect(names(configFrom('labels:\n  level:\n    values: [sandbox, incubation]\n    exclusive: true\n'))).toEqual(
      expect.arrayContaining(['level/sandbox', 'level/incubation']),
    )
  })

  it('includes the configured hold label next to hold', () => {
    const labels = desiredLabels(configFrom('hold:\n  label: do-not-merge/hold\n'))

    expect(labels.map(l => l.name)).toEqual(expect.arrayContaining(['hold', 'do-not-merge/hold']))
    expect(labels.find(l => l.name === 'do-not-merge/hold')).toEqual({
      name: 'do-not-merge/hold',
      ...builtinLabelDefaults['do-not-merge/hold'],
    })
  })

  it('includes every require_matching_label missing label with the needs- color', () => {
    const labels = desiredLabels(configFrom(`
require_matching_label:
  - regexp: ^kind/
    missing_label: needs-kind
  - regexp: ^area/
    missing_label: triage/unlabeled
`))

    expect(labels.find(l => l.name === 'needs-kind')).toEqual({ name: 'needs-kind', color: 'ededed' })
    expect(labels.find(l => l.name === 'triage/unlabeled')).toEqual({ name: 'triage/unlabeled' })
  })

  it('de-duplicates case-insensitively, first definition wins', () => {
    const labels = desiredLabels(configFrom(`
labels:
  labels:
    - name: LGTM
      color: '111111'
    - name: Documentation
      description: first
    - name: documentation
      description: second
`))

    expect(labels.filter(l => l.name.toLowerCase() === 'lgtm')).toEqual([{ name: 'LGTM', color: '111111', description: builtinLabelDefaults.lgtm.description }])
    expect(labels.filter(l => l.name.toLowerCase() === 'documentation')).toEqual([{ name: 'Documentation', description: 'first' }])
  })

  it('is sorted by name', () => {
    const result = names(configFrom('labels:\n  kind: [zeta, alpha]\n  area: [mid]\n'))

    expect(result).toEqual([...result].sort((a, b) => a.localeCompare(b)))
  })

  it('lets the configuration override a built-in default and leaves unknown labels without a color', () => {
    const labels = desiredLabels(configFrom(`
labels:
  lifecycle:
    - name: stale
      color: 123abc
    - frozen
  kind: [bug]
`))

    expect(labels.find(l => l.name === 'lifecycle/stale')).toEqual({
      name: 'lifecycle/stale',
      color: '123abc',
      description: builtinLabelDefaults['lifecycle/stale'].description,
    })
    expect(labels.find(l => l.name === 'lifecycle/frozen')).toEqual({ name: 'lifecycle/frozen', ...builtinLabelDefaults['lifecycle/frozen'] })
    expect(labels.find(l => l.name === 'kind/bug')).toEqual({ name: 'kind/bug' })
    expect(labels.find(l => l.name === 'stage/alpha')).toEqual({ name: 'stage/alpha' })
  })

  it('gives every action-managed label its built-in color', () => {
    const labels = desiredLabels(configFrom(''))

    for (const name of actionManaged) {
      expect(labels.find(l => l.name === name)).toEqual({ name, ...builtinLabelDefaults[name] })
    }
  })
})
