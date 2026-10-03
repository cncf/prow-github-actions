import { readFileSync } from 'node:fs'
import * as path from 'node:path'
import * as yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'

import { fixedLabelCommands } from '../src/labels/fixed'
import { prefixedLabelCommands, removeCommandFor } from '../src/labels/prefixed'

const root = path.resolve(__dirname, '..')
const commandsDoc = 'docs/commands.md'
const dispatcher = 'src/issueComment/handleIssueComment.ts'
const reusableWorkflowPath = '.github/workflows/prow.yml'

function read(file: string): string {
  return readFileSync(path.join(root, file), 'utf8')
}

const dispatcherSource = read(dispatcher)

// the hand-written handlers: `'/assign': context => assign(context),`
const handlerCommands = [...dispatcherSource.matchAll(/^\s+'(\/[a-z-]+)': context =>/gm)].map(m => m[1])

// the explicit Prow-style aliases: `'/hold': ['/unhold', '/remove-hold'],`
const explicitAliases = [...dispatcherSource.matchAll(/^\s+'(\/[a-z-]+)': \[([^\]]+)\],/gm)]
  .flatMap(m => [...m[2].matchAll(/'(\/[a-z-]+)'/g)].map(a => a[1]))

const labelCommands = [...prefixedLabelCommands, ...fixedLabelCommands].map(cmd => cmd.command)
const labelRemoveCommands = labelCommands.map(removeCommandFor)

const implemented = new Set([...handlerCommands, ...explicitAliases, ...labelCommands, ...labelRemoveCommands])

// the documented commands: the first cell of every table row that starts with a `/command`
const documented = new Set(
  read(commandsDoc)
    .split('\n')
    .filter(line => line.startsWith('`/'))
    .map(line => line.split(' | ')[0])
    .flatMap(cell => [...cell.matchAll(/`(\/[a-z-]+)[ `<]/g)].map(m => m[1]))
    // `/<key>` and `/remove-<key>` describe the dynamic label commands, not a fixed command
    .filter(cmd => !cmd.endsWith('-') && cmd !== '/'),
)

const unsupported = ['/override', '/skip', '/retest-required']

describe(`${commandsDoc} agrees with the dispatcher`, () => {
  it('finds the handlers, the aliases and the label commands in the source', () => {
    expect(handlerCommands).toEqual(expect.arrayContaining(['/assign', '/lgtm', '/approve', '/retest', '/meow']))
    expect(explicitAliases).toEqual(expect.arrayContaining(['/remove-lgtm', '/remove-approve', '/unhold', '/remove-hold']))
    expect(new Set(handlerCommands).size).toBe(handlerCommands.length)
    expect(new Set(explicitAliases).size).toBe(explicitAliases.length)
  })

  it('documents every implemented command', () => {
    for (const cmd of implemented) {
      expect(documented, `${cmd} is implemented but has no row in ${commandsDoc}`).toContain(cmd)
    }
  })

  it('documents no command the dispatcher does not implement', () => {
    for (const cmd of documented) {
      expect(implemented, `${cmd} has a row in ${commandsDoc} but no handler`).toContain(cmd)
    }
  })

  it('lists the unsupported Prow commands as unsupported, without a row and without a handler', () => {
    const doc = read(commandsDoc)
    for (const cmd of unsupported) {
      expect(doc).toContain(`\`${cmd}\``)
      expect(documented, `${cmd} must not have a command row`).not.toContain(cmd)
      expect(implemented, `${cmd} must not be implemented`).not.toContain(cmd)
    }
  })
})

describe(`${reusableWorkflowPath} prow-commands default`, () => {
  interface Reusable { on: { workflow_call: { inputs: Record<string, { default?: string }> } } }
  const reusable = yaml.load(read(reusableWorkflowPath)) as Reusable
  const defaults = String(reusable.on.workflow_call.inputs['prow-commands'].default).split(/\s+/)

  it('is every handler and label command except /meow, with no alias and no remove form', () => {
    const expected = [...handlerCommands.filter(cmd => cmd !== '/meow'), ...labelCommands]
    expect([...defaults].sort()).toEqual([...expected].sort())
  })
})
