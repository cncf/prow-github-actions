import { readdirSync, readFileSync } from 'node:fs'
import * as path from 'node:path'

import * as yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'
import { root } from './utils/workflowYaml'

// Merge gate for the prow-github-app chart (issue #672). helm unittest only checks
// what a case asserts, so a schema rule or a template arm nobody exercises can
// rot unnoticed. This file pins two static properties, from the chart's own files:
//   (a) every value that gates a template arm ({{ if }}, {{ with }}, {{ range }},
//       {{ else if }}) is `set:` by at least one helm unittest case;
//   (b) every value the schema constrains (enum, pattern, minimum, minLength,
//       required, additionalProperties: false) is `set:` by at least one case that
//       asserts failedTemplate, i.e. the rejection is actually driven.
// A deliberate exception goes in ALLOWED with the reason it cannot be tested.

const chartDir = path.join(root, 'charts', 'prow-github-app')

/** path -> reason; the path is exactly what the failure message prints. Empty: every gap is covered. */
const ALLOWED: Record<string, string> = {}

/** the root object has no values path of its own */
const ROOT = '(root)'
const constraintKeys = ['enum', 'pattern', 'minimum', 'minLength'] as const

interface Constraint {
  /** values path the constraint is attributed to */
  path: string
  keyword: string
  /** for additionalProperties: false, the declared child names; a rejection needs an undeclared sibling */
  declared?: ReadonlySet<string>
}

type Json = Record<string, unknown>

function isObject(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function objectsAt(schema: Json, key: string): Json[] {
  const value = schema[key]
  if (Array.isArray(value))
    return value.filter(isObject)
  return isObject(value) ? [value] : []
}

function join(parent: string, child: string): string {
  return parent === ROOT ? child : `${parent}.${child}`
}

// Walks one schema node. `owner` is the values path the node's own keywords are
// attributed to. Branches of anyOf/oneOf are alternatives: a case cannot reject
// "this branch", only the whole group, so everything inside a branch is attributed
// to the path that owns the anyOf (see attributeToOwner).
function collect(schema: Json, owner: string, out: Constraint[], attributeToOwner = false): void {
  const at = (child: string): string => (attributeToOwner ? owner : join(owner, child))
  for (const keyword of constraintKeys) {
    if (keyword in schema)
      out.push({ path: owner, keyword })
  }
  if (Array.isArray(schema.required)) {
    for (const name of schema.required) {
      if (typeof name === 'string')
        out.push({ path: at(name), keyword: 'required' })
    }
  }
  const { properties } = schema
  if (schema.additionalProperties === false)
    out.push({ path: owner, keyword: 'additionalProperties', declared: new Set(isObject(properties) ? Object.keys(properties) : []) })
  if (isObject(properties)) {
    for (const [name, child] of Object.entries(properties)) {
      if (isObject(child))
        collect(child, at(name), out, attributeToOwner)
    }
  }
  for (const key of ['if', 'then', 'else', 'allOf'])
    objectsAt(schema, key).forEach(branch => collect(branch, owner, out, attributeToOwner))
  for (const key of ['anyOf', 'oneOf'])
    objectsAt(schema, key).forEach(branch => collect(branch, owner, out, true))
}

const schema = JSON.parse(readFileSync(path.join(chartDir, 'values.schema.json'), 'utf8')) as Json
const constraints: Constraint[] = []
collect(schema, ROOT, constraints)

// `{{ if .Values.a.b }}`, `{{- with ... }}`, `{{ else if ... }}`, `{{ range ... }}`: every
// .Values path inside the action's own braces, e.g. both of `if or .Values.a .Values.b`
const actionPattern = /\{\{-?\s*(?:else\s+if|if|with|range)\b([^}]*)\}\}/g
const valuesPattern = /\.Values\.([\w.]+)/g

function gatingPaths(): Map<string, string[]> {
  const gates = new Map<string, string[]>()
  const dir = path.join(chartDir, 'templates')
  for (const file of readdirSync(dir).filter(name => /\.(?:yaml|tpl)$/.test(name))) {
    for (const action of readFileSync(path.join(dir, file), 'utf8').matchAll(actionPattern)) {
      for (const ref of (action[1] ?? '').matchAll(valuesPattern)) {
        const valuesPath = (ref[1] ?? '').replace(/\.$/, '')
        gates.set(valuesPath, [...(gates.get(valuesPath) ?? []), file])
      }
    }
  }
  return gates
}

interface Case { file: string, name: string, set: string[], failsTemplate: boolean }

/** `ingress.hosts[0].host` and `a\.b` both name a values path; keep the dotted path */
function normaliseKey(key: string): string {
  return key.replace(/\[\d+\]/g, '').replace(/\\\./g, '.')
}

function testCases(): Case[] {
  const dir = path.join(chartDir, 'tests')
  return readdirSync(dir).filter(name => name.endsWith('_test.yaml')).sort().flatMap((file) => {
    const suite = yaml.load(readFileSync(path.join(dir, file), 'utf8')) as { set?: Json, tests?: Json[] }
    return (suite.tests ?? []).map((test) => {
      const set = { ...suite.set, ...(isObject(test.set) ? test.set : {}) }
      const asserts = Array.isArray(test.asserts) ? test.asserts : []
      return {
        file,
        name: String(test.it),
        set: Object.keys(set).map(normaliseKey),
        failsTemplate: asserts.some(entry => isObject(entry) && 'failedTemplate' in entry),
      }
    })
  })
}

const cases = testCases()

function sets(key: string, valuesPath: string): boolean {
  return key === valuesPath || key.startsWith(`${valuesPath}.`) || valuesPath === ROOT
}

function reported(offenders: string[]): string[] {
  return [...new Set(offenders)].filter(offender => !(offender in ALLOWED)).sort()
}

describe('chart assertions (#672)', () => {
  it('finds schema constraints, template gates, and test cases to check', () => {
    // Given the chart as committed / Then the collectors saw real input, so the gates below cannot pass vacuously
    expect(constraints.length).toBeGreaterThan(20)
    expect(gatingPaths().size).toBeGreaterThan(10)
    expect(cases.filter(c => c.failsTemplate).length).toBeGreaterThan(10)
  })

  it('exercises every value that gates a template arm in at least one test case', () => {
    // Given every .Values path inside an if/with/range/else-if in templates/
    const untested = [...gatingPaths().keys()].filter(gate => !cases.some(c => c.set.some(key => sets(key, gate))))
    // Then each one is set by some case, or is allowlisted with a reason
    expect(reported(untested), 'template-gating values no test case sets').toEqual([])
  })

  it('drives every schema-constrained value through a failedTemplate case', () => {
    const failing = cases.filter(c => c.failsTemplate)
    // Given every path the schema constrains
    const undriven = constraints
      .filter(({ path: valuesPath, declared }) => !failing.some(c => c.set.some((key) => {
        if (!declared)
          return sets(key, valuesPath)
        // additionalProperties: false is only driven by a key the schema does not declare
        const rest = valuesPath === ROOT ? key : key.startsWith(`${valuesPath}.`) ? key.slice(valuesPath.length + 1) : undefined
        return rest !== undefined && !declared.has(rest.split('.')[0] ?? '')
      })))
      .map(({ path: valuesPath, declared }) => (declared ? join(valuesPath, '*') : valuesPath))
    // Then each one is set by a case that asserts failedTemplate, or is allowlisted with a reason
    expect(reported(undriven), 'schema-constrained values no failedTemplate case sets').toEqual([])
  })

  it('keeps every ALLOWED entry real: named, reasoned, and still needed', () => {
    const needed = new Set<string>([
      ...[...gatingPaths().keys()].filter(gate => !cases.some(c => c.set.some(key => sets(key, gate)))),
      ...constraints.map(({ path: p, declared }) => (declared ? join(p, '*') : p)),
    ])
    for (const [entry, reason] of Object.entries(ALLOWED)) {
      expect(reason.length, `${entry} needs a reason`).toBeGreaterThan(20)
      expect(needed.has(entry), `${entry} no longer names a gated or constrained path`).toBe(true)
    }
  })
})
