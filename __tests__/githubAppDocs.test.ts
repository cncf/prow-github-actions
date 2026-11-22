import { readFileSync } from 'node:fs'
import * as path from 'node:path'
import * as yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'

import { treeRoot } from './treeRoot'

// the tree's copies: a Stryker sandbox holds instrumented sources the patterns below cannot read
const root = treeRoot(__dirname)
const doc = 'docs/github-app.md'
const settings = 'src/adapters/app/settings.ts'
const server = 'src/server/node.ts'
const chartEnv = 'charts/prow-github-app/templates/_helpers.tpl'
const chartConfigMap = 'charts/prow-github-app/templates/configmap.yaml'

function read(file: string): string {
  return readFileSync(path.join(root, file), 'utf8')
}

interface Row { required: string, meaning: string }

// the `Variable | Required | Meaning` table under "## Configure": variable → its other two cells
function configureTable(text: string): Map<string, Row> {
  const lines = text.split('\n')
  const header = lines.indexOf('| Variable | Required | Meaning |')
  expect(header, `${doc}: no \`Variable | Required | Meaning\` table`).toBeGreaterThan(-1)
  const rows = new Map<string, Row>()
  for (const line of lines.slice(header + 2)) {
    const cells = /^\| `([A-Z][A-Z0-9_]+)` \| ([^|]+) \| (.+) \|$/.exec(line)
    if (cells === null) {
      break
    }
    rows.set(cells[1], { required: cells[2].trim(), meaning: cells[3].trim() })
  }
  return rows
}

// every variable a source dereferences from its `env` record: env.X, env['X'] and required(env, 'X')
function envReads(source: string): Set<string> {
  return new Set([...source.matchAll(/\benv(?:\.|\[')([A-Z][A-Z0-9_]+)|required\(env, '([A-Z][A-Z0-9_]+)'\)/g)].map(m => m[1] ?? m[2]))
}

// the action input → variable table settingsFromEnv walks with `env[variable]`
function mirroredInputs(source: string): Map<string, string> {
  return new Map([...source.matchAll(/^\s+'?([a-z-]+)'?: '([A-Z_]+)',$/gm)].map(m => [m[2], m[1]]))
}

const settingsSource = read(settings)
const serverSource = read(server)
const table = configureTable(read(doc))
const mirrored = mirroredInputs(settingsSource)
const serverReads = new Set([...envReads(settingsSource), ...mirrored.keys(), ...envReads(serverSource)])

// PROW_REPLICAS is the chart's way of telling the server its own replica count; an operator
// never sets it, so it is explained in the replicas section and has no row in the table
const chartOnly = new Set(['PROW_REPLICAS'])

describe(`${doc} "Configure" table agrees with the variables the server reads`, () => {
  it('finds the table and the reads', () => {
    expect(table.size).toBeGreaterThan(0)
    expect(mirrored.size).toBeGreaterThan(0)
    expect(serverReads.size).toBeGreaterThan(table.size)
  })

  it('has one row per variable the server reads, and no row for one it ignores', () => {
    const read = [...serverReads].filter(name => !chartOnly.has(name)).sort()
    expect([...table.keys()].sort()).toEqual(read)
  })

  it('explains each chart-only variable in prose instead', () => {
    for (const name of chartOnly) {
      expect(serverReads, `${name} is no longer read by the server`).toContain(name)
      expect(read(doc)).toContain(`\`${name}\``)
    }
  })

  it('marks required exactly the variables settingsFromEnv refuses to start without', () => {
    const required = [...settingsSource.matchAll(/required\(env, '([A-Z_]+)'\)/g)].map(m => m[1]).sort()
    expect(required.length).toBeGreaterThan(0)
    expect([...table].filter(([, row]) => row.required === 'yes').map(([name]) => name).sort()).toEqual(required)
  })

  it('states the default each `env.X ?? <value>` fallback in the server applies', () => {
    const fallbacks = [...serverSource.matchAll(/env\.([A-Z][A-Z0-9_]+) \?\? ([0-9_]+)/g)]
      .map(m => [m[1], m[2].replace(/_/g, '')] as const)
      // the scheduler's 0 and the single replica's 1 are sentinels for "unset", not defaults an operator reads
      .filter(([, value]) => value !== '0' && value !== '1')
    expect(fallbacks.length).toBeGreaterThan(0)
    for (const [name, value] of fallbacks) {
      expect(table.get(name)?.meaning, `${name} falls back to ${value}`).toContain(`default \`${value}\``)
    }
    const documented = [...table].filter(([, row]) => /\bdefault `/i.test(row.meaning)).map(([name]) => name).sort()
    // PROW_JOBS defaults inside settingsFromEnv, not through a `??` in the server
    expect(documented).toEqual([...fallbacks.map(([name]) => name), 'PROW_JOBS'].sort())
  })

  it('states the job the scheduler runs when PROW_JOBS is unset', () => {
    const jobs = /inputs: AppSettings\['inputs'\] = \{ jobs: '([a-z-]+)' \}/.exec(settingsSource)
    expect(jobs).not.toBeNull()
    expect(table.get('PROW_JOBS')?.meaning).toContain(`Default \`${jobs![1]}\``)
  })

  it('maps each "same as" row onto the action input settingsFromEnv mirrors, and nothing else', () => {
    const sameAs = new Map([...table].flatMap(([name, row]) => {
      const input = /same as (?:the action's )?`([a-z-]+)`/.exec(row.meaning)
      return input === null ? [] : [[name, input[1]] as const]
    }))
    expect(sameAs).toEqual(mirrored)
    const actionInputs = (yaml.load(read('action.yml')) as { inputs: Record<string, unknown> }).inputs
    for (const input of sameAs.values()) {
      expect(actionInputs, `action.yml has no \`${input}\` input`).toHaveProperty(input)
    }
  })

  it('leaves the Redis row conditional on replicas, as storesFromEnv is', () => {
    expect(serverSource).toMatch(/if \(env\.REDIS_URL\)/)
    expect(table.get('REDIS_URL')?.required).toBe('for several replicas')
    expect(table.get('REDIS_URL')?.meaning).toContain('(#one-replica-or-several)')
    expect(read(doc)).toMatch(/^### One replica or several$/m)
  })
})

describe('the chart sets only variables the server reads', () => {
  // the shared env block: `- name: X`; the ConfigMap the pods envFrom: `  X: {{ ... }}`
  const envBlock = /\{\{- define "prow-github-app.env" -\}\}([\s\S]*?)\{\{- end -\}\}/.exec(read(chartEnv))
  const chartNames = [
    ...[...(envBlock?.[1] ?? '').matchAll(/^- name: ([A-Z][A-Z0-9_]+)$/gm)].map(m => m[1]),
    ...[...read(chartConfigMap).matchAll(/^ {2}([A-Z][A-Z0-9_]+): /gm)].map(m => m[1]),
  ]

  it('finds the env block and the ConfigMap keys', () => {
    expect(envBlock).not.toBeNull()
    expect(chartNames).toEqual(expect.arrayContaining(['GITHUB_APP_ID', 'PROW_REPLICAS', 'PROW_JOBS']))
  })

  it('names no variable the server would ignore', () => {
    for (const name of new Set(chartNames)) {
      expect(serverReads, `the chart sets ${name}`).toContain(name)
    }
  })

  it('wires every required variable', () => {
    for (const [name, row] of table) {
      if (row.required === 'yes') {
        expect(chartNames, `the chart does not set ${name}`).toContain(name)
      }
    }
  })
})
