import { existsSync, readdirSync, readFileSync } from 'node:fs'
import * as path from 'node:path'
import * as yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'

import { fixedLabelCommands } from '../src/labels/fixed'
import { prefixedLabelCommands } from '../src/labels/prefixed'

const root = path.resolve(__dirname, '..')
const reusableWorkflowPath = '.github/workflows/prow.yml'
const reusableWorkflowRef = 'cncf/prow-github-actions/.github/workflows/prow.yml@v3'

type Mapping = Record<string, unknown>
interface Step { uses?: string, with?: Mapping, run?: string }
interface Job { uses?: string, with?: Mapping, permissions?: Mapping, steps?: Step[] }
interface Workflow {
  on: Mapping
  permissions?: Mapping
  concurrency?: Mapping
  jobs: Record<string, Job>
}

function expression(inner: string): string {
  return `$\{{ ${inner} }}`
}

function read(file: string): string {
  return readFileSync(path.join(root, file), 'utf8')
}

function loadYaml<T>(file: string): T {
  return yaml.load(read(file)) as T
}

const actionInputs = Object.keys((loadYaml<{ inputs: Mapping }>('action.yml')).inputs)
const reusable = loadYaml<Workflow>(reusableWorkflowPath)
const workflowCall = reusable.on.workflow_call as { inputs: Mapping, secrets: Mapping }
const reusableJob = reusable.jobs.prow

// inputs the reusable workflow deliberately maps from secrets rather than exposing as inputs
const secretBackedInputs = ['github-token', 'cat-api-key']

describe('the reusable workflow mirrors action.yml', () => {
  it('has exactly one job', () => {
    expect(Object.keys(reusable.jobs)).toEqual(['prow'])
  })

  it('exposes every action input except the secret-backed ones, and nothing else', () => {
    const exposed = Object.keys(workflowCall.inputs).sort()
    const expected = actionInputs.filter(name => !secretBackedInputs.includes(name)).sort()
    expect(exposed).toEqual(expected)
  })

  it('declares the secret-backed inputs as optional secrets', () => {
    expect(Object.keys(workflowCall.secrets).sort()).toEqual(['cat-api-key', 'token'])
    for (const secret of Object.values(workflowCall.secrets) as Mapping[]) {
      expect(secret.required).toBe(false)
    }
  })

  it('passes every declared input and github-token to the action', () => {
    const actionStep = reusableJob.steps?.find(step => step.uses === './.prow-github-actions')
    expect(actionStep).toBeDefined()
    const passed = actionStep!.with!

    for (const name of Object.keys(workflowCall.inputs)) {
      expect(passed[name]).toBe(expression(`inputs.${name}`))
    }
    expect(passed['github-token']).toBe(expression('secrets.token || github.token'))
    expect(passed['cat-api-key']).toBe(expression('secrets.cat-api-key'))
    expect(Object.keys(passed).sort()).toEqual(actionInputs.slice().sort())
  })

  it('runs the action at the commit of the workflow file itself', () => {
    const checkout = reusableJob.steps?.find(step => step.uses?.startsWith('actions/checkout@'))
    expect(checkout?.with).toMatchObject({
      'repository': 'cncf/prow-github-actions',
      'ref': expression('job.workflow_sha'),
      'path': '.prow-github-actions',
      'persist-credentials': false,
    })
    expect(reusable.concurrency).toBeUndefined()
  })

  it('enables every built-in label command by default', () => {
    const defaults = String((workflowCall.inputs['prow-commands'] as Mapping).default).split(/\s+/)
    expect(new Set(defaults).size).toBe(defaults.length)
    for (const cmd of [...prefixedLabelCommands, ...fixedLabelCommands]) {
      expect(defaults).toContain(cmd.command)
    }
    expect(defaults).not.toContain('/meow')
    expect((workflowCall.inputs.jobs as Mapping).default).toBe('lgtm')
  })
})

function workflowFiles(dir: string): string[] {
  const full = path.join(root, dir)
  if (!existsSync(full)) {
    return []
  }
  return readdirSync(full)
    .filter(file => file.endsWith('.yml') || file.endsWith('.yaml'))
    .map(file => path.posix.join(dir, file))
}

const pinnedUses = /^[\w.-]+\/[\w.-]+(?:\/[^@\s]+)?@([0-9a-f]{40})$/

function everyUses(workflow: Workflow): string[] {
  return Object.values(workflow.jobs).flatMap(job => [
    ...(job.uses ? [job.uses] : []),
    ...(job.steps ?? []).flatMap(step => (step.uses ? [step.uses] : [])),
  ])
}

describe.each([...workflowFiles('.github/workflows'), ...workflowFiles('templates/workflow-templates')])('%s', (file) => {
  const workflow = loadYaml<Workflow>(file)
  const lines = read(file).split('\n')

  it('pins every action and reusable workflow to a full sha with a version comment', () => {
    for (const uses of everyUses(workflow)) {
      if (uses.startsWith('./') || uses === reusableWorkflowRef) {
        continue
      }
      expect(uses, `${file}: ${uses}`).toMatch(pinnedUses)
      const line = lines.find(l => l.includes(`uses: ${uses}`))
      expect(line, `${file}: no source line for ${uses}`).toBeDefined()
      expect(line, `${file}: ${uses} lacks a '# vX.Y.Z' comment`).toMatch(/# v\d+\.\d+\.\d+/)
    }
  })
})
