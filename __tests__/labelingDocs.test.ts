import { readFileSync } from 'node:fs'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'

import { okToTestLabel } from '../src/issueComment/trigger'
import { fixedLabelCommands } from '../src/labels/fixed'
import { legacyHoldLabel } from '../src/labels/hold'
import { isProtectedLabel, labelCommandName, prefixedLabelCommands } from '../src/labels/prefixed'
import { defaultHoldLabel } from '../src/utils/config'
import { builtinLabelDefaults } from '../src/utils/labelCatalog'
import { treeRoot } from './treeRoot'

// the tree's copies of the sources: a Stryker sandbox holds instrumented ones the string checks cannot read
const root = treeRoot(__dirname)
const docPath = 'docs/labeling.md'
const prefixedPath = 'src/labels/prefixed.ts'
const configPath = 'src/utils/config.ts'
const labelingPath = 'src/utils/labeling.ts'
const ownersLabelPath = 'src/plugins/ownersLabel.ts'

function read(file: string): string {
  return readFileSync(path.join(root, file), 'utf8')
}

const doc = read(docPath)

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

/** every `code` span of a cell */
function codes(cell: string): string[] {
  return [...cell.matchAll(/`([^`]+)`/g)].map(m => m[1])
}

function sorted(values: readonly string[]): string[] {
  return [...values].sort()
}

/** a template-literal error or log message in `source`, with `${...}` holes replaced by `<...>` */
function expectMessage(source: string, sourcePath: string, pattern: RegExp, documented: string): void {
  const match = pattern.exec(source)
  expect(match, `${sourcePath} no longer emits ${pattern}`).not.toBeNull()
  expect(doc, `${docPath} does not quote the ${sourcePath} message`).toContain(documented)
}

describe(`${docPath} built-in values table agrees with ${prefixedPath}`, () => {
  const rows = table('Command | Built-in values')
  const builtIn = prefixedLabelCommands.filter(cmd => cmd.defaultValues !== undefined)

  it('has one row per command with defaultValues and no other', () => {
    expect(sorted(rows.map(([command]) => codes(command)[0]))).toEqual(sorted(builtIn.map(cmd => cmd.command)))
  })

  it.each(builtIn.map(cmd => [cmd.command, cmd] as const))('%s lists its defaultValues in order', (command, cmd) => {
    const row = rows.find(cells => codes(cells[0])[0] === command)!
    expect(codes(row[1])).toEqual(cmd.defaultValues)
  })

  it('says all three are exclusive, as the registry marks them', () => {
    expect(builtIn.every(cmd => cmd.exclusive)).toBe(true)
    expect(doc).toContain('All three are exclusive')
    expect(builtIn).toHaveLength(3)
  })

  it('shows the lifecycle example replacing a built-in with a value the registry does not ship', () => {
    const lifecycle = builtIn.find(cmd => cmd.command === '/lifecycle')!
    expect(lifecycle.defaultValues).toContain('frozen')
    expect(doc).toMatch(/^lifecycle:\n {2}- frozen\n/m)
  })
})

describe(`${docPath} help table agrees with src/labels/fixed.ts`, () => {
  const rows = table('Command | Adds | `/remove-` form removes')

  it('has one row per fixed command and no other', () => {
    expect(sorted(rows.map(([command]) => codes(command)[0]))).toEqual(sorted(fixedLabelCommands.map(cmd => cmd.command)))
  })

  it.each(fixedLabelCommands.map(cmd => [cmd.command, cmd] as const))('%s lists its add and remove labels in order', (command, cmd) => {
    const row = rows.find(cells => codes(cells[0])[0] === command)!
    expect(codes(row[1])).toEqual(cmd.add)
    expect(codes(row[2])).toEqual(cmd.remove)
  })

  it('names labels with spaces, which the label sections cannot list', () => {
    for (const cmd of fixedLabelCommands) {
      for (const label of [...cmd.add, ...cmd.remove]) {
        expect(label, `${cmd.command} ${label}`).toContain(' ')
      }
    }
  })
})

describe(`${docPath} built-in labels table agrees with src/utils/labelCatalog.ts`, () => {
  const rows = table('Label | Applied by | Meaning')
  const labels = rows.flatMap(([label]) => codes(label))

  it('names lgtm, approved, the hold labels, the help labels and ok-to-test', () => {
    const expected = ['lgtm', 'approved', defaultHoldLabel, 'hold.label', legacyHoldLabel, ...fixedLabelCommands.flatMap(cmd => cmd.add), okToTestLabel]
    expect(sorted(labels)).toEqual(sorted([...new Set(expected)]))
  })

  it('has a catalogue color for every listed label except the hold.label placeholder', () => {
    for (const label of labels.filter(name => name !== 'hold.label')) {
      expect(builtinLabelDefaults, label).toHaveProperty(label)
    }
  })

  it('credits each label to the command or plugin that applies it', () => {
    const appliedBy = new Map(rows.map(([label, by]) => [codes(label)[0], by]))
    expect(appliedBy.get('lgtm')).toBe('`/lgtm`')
    expect(appliedBy.get(defaultHoldLabel)).toBe('`/hold`')
    expect(appliedBy.get(okToTestLabel)).toBe('`/ok-to-test`')
    expect(codes(appliedBy.get('help wanted')!)).toEqual(fixedLabelCommands.map(cmd => cmd.command))
  })
})

describe(`${docPath} /label refusals agree with isProtectedLabel`, () => {
  it('names the labels /label and /remove-label always refuse', () => {
    expect(doc).toContain('`lgtm`, `hold`, `approved`, `do-not-merge/*` and a configured `hold.label` are always\nrefused by `/label` and `/remove-label`')
    for (const label of ['lgtm', 'hold', 'approved', 'do-not-merge/anything', 'Do-Not-Merge/hold']) {
      expect(isProtectedLabel(label), label).toBe(true)
    }
    expect(isProtectedLabel('custom-hold')).toBe(false)
    expect(isProtectedLabel('custom-hold', ['Custom-Hold'])).toBe(true)
  })
})

describe(`${docPath} quotes the key pattern and the messages the code emits`, () => {
  const prefixedSource = read(prefixedPath)

  it('quotes labelCommandName as the usable key pattern', () => {
    expect(doc).toContain(`(\`${labelCommandName.source}\`)`)
    expect(labelCommandName.flags).toBe('')
    expect(labelCommandName.test('kind')).toBe(true)
    expect(labelCommandName.test('Kind')).toBe(false)
    expect(labelCommandName.test('1kind')).toBe(false)
  })

  it('quotes the missing-args and no-allowed-value failures of a prefixed command', () => {
    expectMessage(prefixedSource, prefixedPath, /`\$\{command\.slice\(1\)\}: command args missing from body`/, '`<key>: command args missing from body`')
    expectMessage(
      prefixedSource,
      prefixedPath,
      /`\$\{command\.slice\(1\)\}: no allowed value in "\$\{args\.join\(' '\)\}"; allowed: \$\{allowed\.join\(', '\) \|\| 'none'\}`/,
      '`<key>: no allowed value in "<values>"; allowed: <a>, <b>, ...`',
    )
  })

  it('quotes the missing-section failure under the could not get labels prefix', () => {
    expectMessage(prefixedSource, prefixedPath, /`\$\{key\}: yaml malformed, expected '\$\{key\}' top level key`/, '`could not get labels from yaml: Error: <key>: yaml malformed, expected \'<key>\' top level key`')
    expect(prefixedSource).toMatch(/`could not get labels from yaml: \$\{e\}`/)
  })

  it('quotes the malformed-section failure of config.ts', () => {
    expectMessage(
      read(configPath),
      configPath,
      /`\$\{key\}: yaml malformed, expected a list of values or \{ values: \[\.\.\.\], exclusive: bool \}`/,
      '`could not get labels from yaml: Error: <key>: yaml malformed, expected a list of values or { values: [...], exclusive: bool }`',
    )
  })

  it('quotes the missing-repository-label failure of assertLabelsExist', () => {
    expectMessage(
      read(labelingPath),
      labelingPath,
      /`the label\(s\) \$\{missing\.join\(', '\)\} cannot be applied because the repository doesn't have them\. Run the label-sync job or create them\.`/,
      'the label(s) kind/cleanup, area/api cannot be applied because the repository doesn\'t have them. Run the label-sync job or create them.',
    )
  })

  it('quotes the owners-label skip line as the plugin logs it', () => {
    expectMessage(
      read(ownersLabelPath),
      ownersLabelPath,
      /`owners-label: skipping label \$\{label\} declared in OWNERS: repository doesn't have it \(run label-sync\)`/,
      '`skipping label area/sdk declared in OWNERS: repository doesn\'t have it (run label-sync)`',
    )
  })
})
