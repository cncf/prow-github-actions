import { existsSync, readdirSync, readFileSync } from 'node:fs'
import * as path from 'node:path'
import * as yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'

import { fixedLabelCommands } from '../src/labels/fixed'
import { prefixedLabelCommands } from '../src/labels/prefixed'
import { mergeProwConfig, parseProwConfig } from '../src/utils/config'
import { builtinLabelDefaults, desiredLabels } from '../src/utils/labelCatalog'

const root = path.resolve(__dirname, '..')
const reusableWorkflowPath = '.github/workflows/prow.yml'
const reusableWorkflowRef = 'cncf/prow-github-actions/.github/workflows/prow.yml@v3'
const templateDir = 'templates/workflow-templates'
const templatePath = `${templateDir}/prow.yml`
const dogfoodPath = '.github/workflows/prow-bot.yml'

/** the events and activity types every feature of the action needs, see docs/events.md */
const requiredTriggers: Record<string, string[]> = {
  issues: ['opened', 'reopened', 'labeled', 'unlabeled'],
  issue_comment: ['created'],
  pull_request: ['opened', 'reopened', 'synchronize', 'ready_for_review', 'labeled', 'unlabeled'],
  pull_request_review: ['submitted', 'dismissed'],
  check_suite: ['completed'],
  schedule: [],
  workflow_dispatch: [],
  push: [],
}

type Mapping = Record<string, unknown>
interface Step { uses?: string, with?: Mapping, run?: string }
interface Job { if?: string, uses?: string, with?: Mapping, permissions?: Mapping, steps?: Step[] }
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

function activityTypes(on: Mapping, event: string): string[] {
  const trigger = on[event] as Mapping | null | undefined
  return Array.isArray(trigger?.types) ? trigger.types as string[] : []
}

describe.each([
  [templatePath, 'pull_request_target'],
  [dogfoodPath, 'pull_request'],
])('%s calls the reusable workflow', (file, pullRequestEvent) => {
  const caller = loadYaml<Workflow>(file)
  const callerJobs = Object.values(caller.jobs)

  it('subscribes to every event and activity type the features need', () => {
    for (const [event, types] of Object.entries(requiredTriggers)) {
      const name = event === 'pull_request' ? pullRequestEvent : event
      expect(caller.on, `${file}: missing on.${name}`).toHaveProperty(name)
      for (const type of types) {
        expect(activityTypes(caller.on, name), `${file}: on.${name} lacks ${type}`).toContain(type)
      }
    }
    expect(caller.on).not.toHaveProperty(pullRequestEvent === 'pull_request' ? 'pull_request_target' : 'pull_request')
  })

  it('grants at least what the reusable job needs', () => {
    for (const [scope, level] of Object.entries(reusableJob.permissions!)) {
      expect(caller.permissions?.[scope], `${file}: permissions.${scope}`).toBe(level)
    }
  })

  it('never cancels a run in progress', () => {
    expect(caller.concurrency?.['cancel-in-progress']).toBe(false)
    expect(caller.concurrency?.group).toContain('github.event.pull_request.number')
  })

  it('routes label-sync to workflow_dispatch and push, everything else to the defaults', () => {
    expect(callerJobs.length).toBe(2)
    const labelSync = callerJobs.find(job => job.with?.jobs === 'label-sync')
    const prow = callerJobs.find(job => job.with?.jobs === undefined)
    expect(labelSync).toBeDefined()
    expect(prow).toBeDefined()
    expect(labelSync).toMatchObject({ if: 'github.event_name == \'workflow_dispatch\' || github.event_name == \'push\'' })
    expect(prow).toMatchObject({ if: 'github.event_name != \'workflow_dispatch\' && github.event_name != \'push\'' })
  })
})

describe(templatePath, () => {
  const template = loadYaml<Workflow>(templatePath)

  it('calls the reusable workflow at the floating major tag with no with: on the main job', () => {
    for (const job of Object.values(template.jobs)) {
      expect(job.uses).toBe(reusableWorkflowRef)
    }
    expect(template.jobs.prow.with).toBeUndefined()
  })

  it('has starter-workflow metadata and an icon next to it', () => {
    const properties = JSON.parse(read(`${templateDir}/prow.properties.json`)) as Mapping
    expect(properties).toMatchObject({ name: 'Prow', iconName: 'prow', categories: ['Automation'] })
    expect(typeof properties.description).toBe('string')
    expect(properties).not.toHaveProperty('filePatterns')
    expect(existsSync(path.join(root, templateDir, 'prow.svg'))).toBe(true)
    expect(read(`${templateDir}/prow.svg`)).toMatch(/^<svg\s/)
  })
})

describe('templates/prow.yaml', () => {
  const text = read('templates/prow.yaml')
  const parsed = parseProwConfig('templates/prow.yaml', text)
  const config = { ...mergeProwConfig({}, parsed), sources: ['templates/prow.yaml'] }
  const catalogue = new Map(desiredLabels(config).map(label => [label.name, label]))

  it('parses as the new form with the sections the guide promises', () => {
    expect(Object.keys(parsed.labels ?? {})).toEqual(expect.arrayContaining(['kind', 'priority', 'lifecycle', 'do-not-merge']))
    expect(parsed.require_matching_label?.map(rule => rule.missing_label)).toEqual(expect.arrayContaining(['needs-kind']))
    expect(parsed.tide).toEqual({ labels: ['lgtm'], missing_labels: ['do-not-merge/*', 'needs-rebase', 'hold'], merge_method: 'merge', merge_on_events: true })
    expect(parsed.hold).toEqual({ label: 'do-not-merge/hold' })
  })

  it('agrees with the label catalogue on every label it names', () => {
    for (const [key, section] of Object.entries(config.labels)) {
      for (const value of section.definitions) {
        const name = `${key}/${value.name}`
        const builtin = builtinLabelDefaults[name]
        if (builtin) {
          expect(value.color, name).toBe(builtin.color)
          expect(value.description, name).toBe(builtin.description)
        }
        expect(catalogue.get(name), name).toMatchObject({ color: value.color?.toLowerCase() })
      }
    }
    for (const rule of config.require_matching_label) {
      expect(catalogue.get(rule.missing_label)).toMatchObject({ color: 'ededed' })
    }
    for (const name of ['lgtm', 'approved', 'do-not-merge/hold']) {
      expect(catalogue.get(name)).toMatchObject(builtinLabelDefaults[name])
    }
  })
})
