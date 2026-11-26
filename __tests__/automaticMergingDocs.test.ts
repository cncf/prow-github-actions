import { readFileSync } from 'node:fs'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'

import { defaultOwnersTideLabels, defaultTideLabels, defaultTideMissingLabels, resolveTide } from '../src/utils/config'
import { treeRoot } from './treeRoot'

// the tree's copy of tide.ts: a Stryker sandbox holds an instrumented one setLiteral cannot read
const root = treeRoot(__dirname)
const docPath = 'docs/automatic-merging.md'
const tidePath = 'src/plugins/tide.ts'
const configPath = 'src/utils/config.ts'

function read(file: string): string {
  return readFileSync(path.join(root, file), 'utf8')
}

const doc = read(docPath)
const tideSource = read(tidePath)
const configSource = read(configPath)

/** the rows of the table whose header line starts with `prefix`, one array of cells per row */
function table(prefix: string): string[][] {
  const lines = doc.split('\n')
  const header = lines.findIndex(line => line.startsWith(prefix))
  expect(header, `no \`${prefix}\` table in ${docPath}`).toBeGreaterThan(-1)
  const rows: string[][] = []
  for (const line of lines.slice(header + 2)) {
    if (line.trim() === '') {
      break
    }
    rows.push(line.split(' | '))
  }
  return rows
}

/** the members of `const <name> = new Set([...])` in tide.ts */
function setLiteral(name: string): string[] {
  const match = new RegExp(`^const ${name} = new Set\\(\\[([^\\]]*)\\]\\)`, 'm').exec(tideSource)
  expect(match, `no \`const ${name} = new Set([...])\` in ${tidePath}`).not.toBeNull()
  return [...match![1].matchAll(/'([a-z_]+)'/g)].map(m => m[1])
}

/** the members of `const <name> = [...] as const` in config.ts */
function arrayLiteral(name: string): string[] {
  const match = new RegExp(`^const ${name} = \\[([^\\]]*)\\] as const`, 'm').exec(configSource)
  expect(match, `no \`const ${name} = [...] as const\` in ${configPath}`).not.toBeNull()
  return [...match![1].matchAll(/'([a-z_]+)'/g)].map(m => m[1])
}

/** every `code` span of a cell */
function codes(cell: string): string[] {
  return [...cell.matchAll(/`([^`]+)`/g)].map(m => m[1])
}

/** the distinct values, sorted: the doc may repeat a span in prose, a Set holds each once */
function sorted(values: readonly string[]): string[] {
  return [...new Set(values)].sort()
}

describe(`${docPath} mergeable_state table agrees with ${tidePath}`, () => {
  const rows = table('`mergeable_state` | Outcome | Why')
  const outcome = new Map(rows.map(([state, result]) => [codes(state)[0], result]))

  it('lists each of the eight states GitHub reports once', () => {
    expect(sorted([...outcome.keys()])).toEqual(sorted(['clean', 'has_hooks', 'unstable', 'blocked', 'behind', 'dirty', 'draft', 'unknown']))
  })

  it('marks exactly the mergeableStates as merge', () => {
    const merging = [...outcome].filter(([, result]) => result === 'merge').map(([state]) => state)
    expect(sorted(merging)).toEqual(sorted(setLiteral('mergeableStates')))
  })

  it('marks unknown as the retried state and every other state as skip', () => {
    expect(outcome.get('unknown')).toBe('retry, then skip')
    for (const [state, result] of outcome) {
      if (state !== 'unknown' && !setLiteral('mergeableStates').includes(state)) {
        expect(result, state).toBe('skip')
      }
    }
  })

  it('quotes the skip log line as skip() and the state fold emit it', () => {
    expect(tideSource).toMatch(/`skipping pr #\$\{number\}: \$\{reason\}`/)
    expect(tideSource).toMatch(/`not mergeable \(\$\{pr\.state\}\)`/)
    expect(doc).toContain('A skip is logged as `skipping pr #<n>: not mergeable (<state>)`')
  })
})

describe(`${docPath} event table agrees with ${tidePath}`, () => {
  const rows = table('Event | Activity types evaluated | Pull request(s)')
  const row = (event: string): string[] => {
    const found = rows.find(cells => codes(cells[0]).includes(event))
    expect(found, `no \`${event}\` row`).toBeDefined()
    return found!
  }

  it('lists the pull_request activity types tide evaluates', () => {
    const [, activity] = row('pull_request')
    const listed = codes(activity).filter(code => code !== 'lgtm')
    expect(sorted(listed)).toEqual(sorted(setLiteral('pullRequestActions')))
  })

  it('lists the pull_request_review activity types tide evaluates', () => {
    const [, activity] = row('pull_request_review')
    expect(sorted(codes(activity))).toEqual(sorted(setLiteral('reviewActions')))
  })

  it('names, between the check_suite and status rows, every conclusion tide treats as hopeless', () => {
    const [, suiteActivity] = row('check_suite')
    const [, statusActivity] = row('status')
    const suiteSkips = codes(suiteActivity).filter(code => code !== 'completed')
    const statusStates = codes(statusActivity)
    expect(statusStates[0]).toBe('success')
    expect(sorted([...suiteSkips, ...statusStates.slice(1)])).toEqual(sorted(setLiteral('hopelessConclusions')))
  })
})

describe(`${docPath} merge gate table agrees with ${configPath}`, () => {
  const rows = table('Key | Default | Rule')
  const byKey = new Map(rows.map(([key, fallback, rule]) => [codes(key)[0], { fallback, rule }]))
  const plain = resolveTide({})
  const withOwners = resolveTide({}, '', { hasOwners: true })

  it('documents the five tide keys and no other', () => {
    expect(sorted([...byKey.keys()])).toEqual(sorted(['labels', 'missing_labels', 'merge_method', 'merge_on_events', 'merge_queue']))
  })

  it('quotes both labels defaults as resolveTide applies them', () => {
    const listed = codes(byKey.get('labels')!.fallback)
    expect(listed).toEqual([`[${defaultTideLabels.join(', ')}]`, `[${defaultOwnersTideLabels.join(', ')}]`])
    expect(plain.labels).toEqual(defaultTideLabels)
    expect(withOwners.labels).toEqual(defaultOwnersTideLabels)
  })

  it('quotes the missing_labels default as resolveTide applies it', () => {
    expect(codes(byKey.get('missing_labels')!.fallback)).toEqual([`[${defaultTideMissingLabels.join(', ')}]`])
    expect(plain.missing_labels).toEqual(defaultTideMissingLabels)
  })

  it('lists every merge method config.ts accepts in the merge_method rule', () => {
    expect(sorted(codes(byKey.get('merge_method')!.rule))).toEqual(sorted(arrayLiteral('mergeMethods')))
  })

  it('quotes the merge_on_events and merge_queue defaults as resolveTide applies them', () => {
    expect(codes(byKey.get('merge_on_events')!.fallback)).toEqual([String(plain.merge_on_events)])
    expect(codes(byKey.get('merge_queue')!.fallback)).toEqual([plain.merge_queue])
    const modes = arrayLiteral('mergeQueueModes')
    expect(modes).toContain(plain.merge_queue)
    const other = modes.filter(mode => mode !== plain.merge_queue)
    expect(codes(byKey.get('merge_queue')!.rule)).toEqual(other)
  })
})

describe(`${docPath} merge queue tables agree with ${tidePath}`, () => {
  it('names exactly the queueRefusedStates as the states this action still refuses on a queue branch', () => {
    const rows = table('Step | Without a queue | With a required queue')
    const stateRow = rows.find(cells => codes(cells[0])[0] === 'mergeable_state')
    expect(stateRow).toBeDefined()
    const [, without, withQueue] = stateRow!
    expect(sorted(codes(without))).toEqual(sorted(setLiteral('mergeableStates')))
    const refused = /^only (.*?) skip;/.exec(withQueue)
    expect(refused, withQueue).not.toBeNull()
    expect(sorted(codes(refused![1]))).toEqual(sorted(setLiteral('queueRefusedStates')))
    const leftToQueue = codes(withQueue.slice(refused![0].length))
    const everyState = [...setLiteral('mergeableStates'), ...setLiteral('queueRefusedStates'), ...leftToQueue]
    expect(sorted(everyState)).toEqual(sorted(['clean', 'has_hooks', 'unstable', 'blocked', 'behind', 'dirty', 'draft', 'unknown']))
  })

  it('quotes the skip reasons of a refused enqueue as the kind switch emits them', () => {
    const rows = table('Message says | Result | Log')
    const log = new Map(rows.map(([says, result, line]) => [says, { result, line }]))
    expect(log.get('the head OID does not match')).toEqual({ result: 'skipped', line: '`skipping pr #<n>: head moved`' })
    expect(log.get('already in the queue')).toEqual({ result: 'skipped', line: '`skipping pr #<n>: already in the merge queue`' })
    expect(log.get('not mergeable / required checks')).toEqual({ result: 'skipped', line: '`skipping pr #<n>: not ready for the merge queue: <GitHub\'s message>`' })
    expect(tideSource).toContain('return skip(number, \'head moved\')')
    expect(tideSource).toContain('return skip(number, \'already in the merge queue\')')
    expect(tideSource).toMatch(/return skip\(number, `not ready for the merge queue: \$\{outcome\.message\}`\)/)
  })

  it('quotes the forbidden-enqueue error exactly as tide.ts logs it', () => {
    const rows = table('Message says | Result | Log')
    const forbidden = rows.find(([says]) => says === 'permission / resource not accessible')
    expect(forbidden).toBeDefined()
    expect(forbidden![1]).toBe('**failed**')
    const quoted = codes(forbidden![2])[0]
    // tide.ts interpolates the number and appends GitHub's message; the doc elides both
    const [prefix, suffix] = quoted.split('#<n>')
    const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    expect(tideSource).toMatch(new RegExp(`\`${escape(prefix)}#\\$\\{number\\}${escape(suffix)}: \\$\\{outcome\\.message\\}\``))
  })

  it('quotes the enqueued info line as tide.ts logs it', () => {
    expect(doc).toContain('logs `enqueued pr #<n> (position P)`')
    expect(tideSource).toMatch(/`enqueued pr #\$\{number\}\$\{outcome\.position === undefined \? '' : ` \(position \$\{outcome\.position\}\)`\}`/)
  })
})
