import type { ProwConfig } from '../src/utils/config'
import { readFileSync } from 'node:fs'
import * as path from 'node:path'
import * as yaml from 'js-yaml'

import { describe, expect, it } from 'vitest'
import { approveSettings } from '../src/plugins/approve'
import { blunderbussSettings } from '../src/plugins/blunderbuss'
import { lgtmSettings } from '../src/plugins/lgtmBinding'
import {
  defaultOwnersTideLabels,
  defaultSweepLookback,
  mergeProwConfig,
  orgConfigPath,
  orgConfigRepos,
  parseProwConfig,
  repoConfigPaths,
  resolveHoldLabel,
  resolveSweepLookback,
  resolveTide,
} from '../src/utils/config'

const docPath = 'docs/configuration.md'
const doc = readFileSync(path.join(path.resolve(__dirname, '..'), docPath), 'utf8')

/** the sections of the document keyed by heading text, each with its body lines */
const sections = new Map<string, string[]>()
{
  let current = ''
  for (const line of doc.split('\n')) {
    const heading = /^#{2,3} (.+)$/.exec(line)
    if (heading) {
      current = heading[1]
      sections.set(current, [])
      continue
    }
    sections.get(current)?.push(line)
  }
}

function section(heading: string): string[] {
  const lines = sections.get(heading)
  expect(lines, `${docPath}: no heading '${heading}'`).toBeDefined()
  return lines!
}

/** the first fenced yaml block of a section */
function yamlBlock(heading: string): string {
  const lines = section(heading)
  const start = lines.indexOf('```yaml')
  const end = lines.indexOf('```', start + 1)
  expect(start, `${docPath}: '${heading}' has no yaml block`).toBeGreaterThanOrEqual(0)
  return lines.slice(start + 1, end).join('\n')
}

/** the `Field | Default | Meaning` rows of a section as field → default cell */
function fieldTable(heading: string): Map<string, string> {
  const rows = section(heading).filter(line => /^`[a-z_]+` \| /.test(line))
  return new Map(rows.map((row) => {
    const [field, cell] = row.split(' | ')
    return [field.slice(1, -1), cell]
  }))
}

function literals(cell: string): unknown[] {
  return [...cell.matchAll(/`([^`]+)`/g)].map(match => yaml.load(match[1]))
}

const empty: ProwConfig = { ...mergeProwConfig({}, {}), sources: [] }
const example = parseProwConfig(docPath, yamlBlock('`prow.yaml`'))

/** what the code resolves for a section nobody configured, keyed like the document headings */
const resolvedDefaults: Record<string, Record<string, unknown>> = {
  tide: resolveTide({}, ''),
  hold: { label: resolveHoldLabel({}) },
  blunderbuss: blunderbussSettings(empty),
  approve: approveSettings(empty),
  lgtm: lgtmSettings(empty),
  sweep: { lookback: defaultSweepLookback },
}

describe(`${docPath} prow.yaml example`, () => {
  it('parses as the new form with every section the parser knows', () => {
    expect(Object.keys(example).sort()).toEqual(Object.keys(mergeProwConfig({}, {})).sort())
    expect(Object.keys(example.labels!)).toEqual(['area', 'kind', 'priority', 'labels'])
    expect(example.require_matching_label).toHaveLength(2)
  })

  it.each(['tide', 'hold', 'approve', 'lgtm', 'sweep'])('spells out the code defaults of %s, as its comment claims', (key) => {
    expect(example[key as keyof typeof resolvedDefaults]).toEqual(resolvedDefaults[key])
  })

  it('names the tide.labels default of a repository with OWNERS files', () => {
    const comment = section('`prow.yaml`').find(line => line.includes('# the merge gate'))
    expect(comment).toContain(`[${defaultOwnersTideLabels.join(', ')}]`)
    expect(resolveTide({}, '', { hasOwners: true }).labels).toEqual(defaultOwnersTideLabels)
  })

  it('documents a sweep.lookback the resolver accepts as the default', () => {
    expect(resolveSweepLookback(example.sweep!)).toBe(resolveSweepLookback({}))
  })
})

describe(`${docPath} section tables`, () => {
  it('has one `### key` heading per configuration section and one for the no-config plugin', () => {
    const headings = [...sections.keys()].map(heading => /^`([a-z_.-]+)`$/.exec(heading)?.[1]).filter((key): key is string => key !== undefined)
    expect(headings.sort()).toEqual([...Object.keys(mergeProwConfig({}, {})), 'prow.yaml', 'owners-label'].sort())
    expect(section('`owners-label`').join('\n')).toContain('No configuration')
  })

  describe.each(Object.keys(resolvedDefaults))('`%s`', (key) => {
    const table = fieldTable(`\`${key}\``)
    const defaults = resolvedDefaults[key]

    it('lists every field the code resolves, and nothing else', () => {
      expect([...table.keys()].sort()).toEqual(Object.keys(defaults).sort())
    })

    it('states the default the code applies', () => {
      for (const [field, cell] of table) {
        const expected = defaults[field]
        if (expected === undefined) {
          expect(cell, `${key}.${field}`).toBe('unset')
          continue
        }
        const candidates = literals(cell)
        expect(candidates, `${key}.${field}: '${cell}' does not name ${JSON.stringify(expected)}`)
          .toContainEqual(expected)
      }
    })
  })

  it('names both tide.labels defaults', () => {
    expect(literals(fieldTable('`tide`').get('labels')!)).toContainEqual(defaultOwnersTideLabels)
  })
})

describe(`${docPath} where configuration lives`, () => {
  const tiers = section('Where configuration lives')
  const row = (tier: string): string => {
    const line = tiers.find(l => l.startsWith(`${tier} | `))
    expect(line, `${docPath}: no '${tier}' tier row`).toBeDefined()
    return line!
  }
  const yamlPaths = repoConfigPaths.filter(file => file.endsWith('.yaml'))

  it('lists the organization repositories in probe order with the shared file name', () => {
    const cells = row('Organization').split(' | ')
    const repos = [...cells[1].matchAll(/<owner>\/(\.[a-z]+)/g)].map(match => match[1])
    expect(repos).toEqual(orgConfigRepos)
    expect(cells[1]).toContain(`\`${orgConfigPath}\``)
  })

  it('lists the repository paths in probe order and defers the .yml spellings to the end', () => {
    const cells = row('Repository').split(' | ')
    expect([...cells[1].matchAll(/`([^`]+)`/g)].map(match => match[1]).filter(file => file !== '.yml')).toEqual(yamlPaths)
    expect(cells[1]).toContain('`.yml` spelling')
    expect(repoConfigPaths).toEqual([...yamlPaths, ...yamlPaths.map(file => file.replace(/\.yaml$/, '.yml'))])
  })

  it('quotes the error getLabelConfig raises when no tier has a file', () => {
    const orgRepos = orgConfigRepos.map(name => `<owner>/${name}`).join(' and ')
    expect(tiers.join('\n')).toContain(
      `\`no prow configuration found: looked for ${orgConfigPath} in ${orgRepos}, and ${yamlPaths.join(', ')} (.yaml/.yml) in <owner>/<repo>\``,
    )
  })
})
