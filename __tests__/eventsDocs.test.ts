import { readFileSync } from 'node:fs'
import * as path from 'node:path'
import * as yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'

import { treeRoot } from './treeRoot'

// the tree's copy of the dispatcher: a Stryker sandbox holds an instrumented one the patterns cannot read
const root = treeRoot(__dirname)
const doc = 'docs/events.md'
const dispatcher = 'src/run.ts'

function read(file: string): string {
  return readFileSync(path.join(root, file), 'utf8')
}

const source = read(dispatcher)

// the dispatch rows: `issue_comment: handleIssueComment,` inside the eventHandlers record
function dispatchRows(): Map<string, string> {
  const block = /const eventHandlers: Record<string, EventHandler> = \{([\s\S]*?)\n\}/.exec(source)
  expect(block, `${dispatcher} has no eventHandlers record`).not.toBeNull()
  return new Map([...block![1].matchAll(/^\s+([a-z_]+): (handle\w+),$/gm)].map(m => [m[1], m[2]]))
}

// `import { handleIssues } from './issues/handleIssues'` -> src/issues/handleIssues.ts
function handlerFile(handler: string): string {
  const match = new RegExp(`^import \\{ ${handler} \\} from '\\./([^']+)'$`, 'm').exec(source)
  expect(match, `${dispatcher} does not import ${handler}`).not.toBeNull()
  return `src/${match![1]}.ts`
}

// the inputs a handler file reads itself through the platform: `inputs.get('jobs', ...)`
function inputReads(file: string): string[] {
  return [...new Set([...read(file).matchAll(/inputs\s*\.\s*get\(\s*(['"`])([^'"`]+)\1/g)].map(m => m[2]))].sort()
}

// the documented rows: `Event | Input | Does` table; a cell may list several events (`check_suite`, `status`)
function handledRows(): { events: string[], inputs: string[] }[] {
  const lines = read(doc).split('\n')
  const header = lines.findIndex(line => line.startsWith('Event | Input | '))
  expect(header, 'no `Event | Input | ...` table').toBeGreaterThan(-1)
  const rows: { events: string[], inputs: string[] }[] = []
  for (const line of lines.slice(header + 2)) {
    if (!line.startsWith('`')) {
      break
    }
    const [eventCell, inputCell] = line.split(' | ')
    rows.push({
      events: [...eventCell.matchAll(/`([a-z_]+)`/g)].map(m => m[1]),
      inputs: [...inputCell.matchAll(/`([a-z-]+)`/g)].map(m => m[1]).sort(),
    })
  }
  return rows
}

const dispatch = dispatchRows()
const rows = handledRows()
const actionInputs = Object.keys((yaml.load(read('action.yml')) as { inputs: Record<string, unknown> }).inputs)

describe(`${doc} agrees with ${dispatcher}`, () => {
  it('finds the dispatch rows in the source', () => {
    expect([...dispatch.keys()]).toEqual(expect.arrayContaining(['issue_comment', 'issues', 'pull_request', 'schedule']))
    expect(new Set(dispatch.values()).size).toBeLessThan(dispatch.size)
  })

  it('lists every dispatched event once in the "Handled today" table and no event the dispatcher lacks', () => {
    const documented = rows.flatMap(row => row.events)
    expect(new Set(documented).size).toBe(documented.length)
    expect(documented.sort()).toEqual([...dispatch.keys()].sort())
  })

  it('groups into one row only events that share a handler', () => {
    for (const row of rows) {
      expect(new Set(row.events.map(event => dispatch.get(event))).size, row.events.join(', ')).toBe(1)
    }
  })

  it('names in the Input column exactly the action inputs the handler file reads', () => {
    for (const row of rows) {
      const file = handlerFile(dispatch.get(row.events[0])!)
      expect(row.inputs, `${row.events.join(', ')} -> ${file}`).toEqual(inputReads(file))
      expect(actionInputs).toEqual(expect.arrayContaining(row.inputs))
    }
  })

  it('names only dispatched events in the "Which events each feature needs" table', () => {
    const lines = read(doc).split('\n')
    const header = lines.findIndex(line => line.startsWith('Feature | Events'))
    expect(header, 'no `Feature | Events` table').toBeGreaterThan(-1)
    const named = new Set<string>()
    for (const line of lines.slice(header + 2)) {
      if (line.trim() === '') {
        break
      }
      for (const m of line.split(' | ')[1].matchAll(/`([a-z_]+)`(?= |$|,)/g)) {
        named.add(m[1])
      }
    }
    expect(named.size).toBeGreaterThan(0)
    for (const event of named) {
      expect(dispatch.has(event), `${event} is not dispatched by ${dispatcher}`).toBe(true)
    }
  })

  it('quotes the unsupported-event annotation as the dispatcher emits it', () => {
    const message = /log\.error\(`\$\{context\.eventName\} (not yet supported)`\)/.exec(source)
    expect(message).not.toBeNull()
    expect(read(doc)).toContain(`\`<event> ${message![1]}\``)
  })
})
