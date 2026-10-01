import { existsSync, readdirSync, readFileSync } from 'node:fs'
import * as path from 'node:path'
import * as yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'

import { dynamicPrefixedCommand, prefixedLabelCommands, sectionFor } from '../src/labels/prefixed'
import { mergeProwConfig, parseProwConfig, repoConfigPaths } from '../src/utils/config'
import { builtinLabelDefaults, desiredLabels } from '../src/utils/labelCatalog'

// The configuration the bot actually loads for this repository, as opposed to
// templates/prow.yaml which is only shipped to consumers. prow-bot.yml runs
// label-sync whenever this file changes on main, so a typo here goes live.
const dogfoodConfigPath = '.github/prow.yaml'
const dogfoodWorkflowPath = '.github/workflows/prow-bot.yml'
const issueTemplateDir = '.github/ISSUE_TEMPLATE'

const root = path.resolve(__dirname, '..')

function read(file: string): string {
  return readFileSync(path.join(root, file), 'utf8')
}

interface Workflow { jobs: Record<string, { with?: Record<string, unknown> }> }

const parsed = parseProwConfig(dogfoodConfigPath, read(dogfoodConfigPath))
const config = { ...mergeProwConfig({}, parsed), sources: [dogfoodConfigPath] }
const catalogue = new Map(desiredLabels(config).map(label => [label.name, label]))

const workflow = yaml.load(read(dogfoodWorkflowPath)) as Workflow
const prowCommands = String(workflow.jobs.prow.with?.['prow-commands']).split(/\s+/)

describe(dogfoodConfigPath, () => {
  it('parses as the new form with label sections, a required-label rule and a tide gate', () => {
    expect(Object.keys(parsed.labels ?? {}).length).toBeGreaterThan(0)
    expect(parsed.require_matching_label?.length).toBeGreaterThan(0)
    expect(parsed.tide).toBeDefined()
  })

  it('is the repository config path the loader probes first, so no other candidate shadows it', () => {
    expect(repoConfigPaths[0]).toBe(dogfoodConfigPath)
    for (const candidate of repoConfigPaths.slice(1)) {
      expect(existsSync(path.join(root, candidate)), candidate).toBe(false)
    }
  })

  it('only declares label sections whose command prow-bot.yml enables', () => {
    for (const key of Object.keys(config.labels)) {
      const cmd = prefixedLabelCommands.find(c => c.allowlistKey === key) ?? dynamicPrefixedCommand(key)
      expect(prowCommands, `${key} section needs ${cmd.command}`).toContain(cmd.command)
    }
  })

  it('gives every enabled built-in label command a section or built-in values to allow', () => {
    for (const cmd of prefixedLabelCommands) {
      if (prowCommands.includes(cmd.command)) {
        expect(sectionFor(config.labels, cmd)?.values.length, cmd.command).toBeGreaterThan(0)
      }
    }
  })

  it('agrees with the label catalogue on every label it names', () => {
    for (const [key, section] of Object.entries(config.labels)) {
      const prefix = prefixedLabelCommands.find(c => c.allowlistKey === key)?.prefix ?? key
      for (const value of section.definitions) {
        const name = prefix === '' ? value.name : `${prefix}/${value.name}`
        const builtin = builtinLabelDefaults[name]
        if (builtin) {
          expect(value.color, name).toBe(builtin.color)
          expect(value.description, name).toBe(builtin.description)
        }
        expect(catalogue.get(name), name).toMatchObject(value.color ? { color: value.color.toLowerCase() } : {})
      }
    }
  })

  it('has a required-label rule that some catalogued label can satisfy, and a missing label the sync creates', () => {
    for (const rule of config.require_matching_label) {
      const pattern = new RegExp(rule.regexp)
      expect([...catalogue.keys()].filter(name => pattern.test(name)), rule.regexp).not.toEqual([])
      expect(catalogue.get(rule.missing_label), rule.missing_label).toMatchObject({ color: 'ededed' })
    }
  })

  it('tells contributors how to satisfy the rule with commands and values that exist', () => {
    for (const rule of config.require_matching_label) {
      const commands = [...(rule.missing_comment ?? '').matchAll(/`(\/[a-z][a-z0-9-]*) ([^`\s]+)`/g)]
      expect(commands.length, rule.missing_label).toBeGreaterThan(0)
      for (const [, command, value] of commands) {
        expect(prowCommands, command).toContain(command)
        const cmd = prefixedLabelCommands.find(c => c.command === command) ?? dynamicPrefixedCommand(command.slice(1))
        const label = cmd.prefix === '' ? value : `${cmd.prefix}/${value}`
        expect(new RegExp(rule.regexp).test(label), `${command} ${value} yields ${label}`).toBe(true)
        expect(catalogue.has(label), label).toBe(true)
      }
    }
  })

  it('uses a merge method GitHub accepts', () => {
    expect(['merge', 'squash', 'rebase']).toContain(config.tide.merge_method)
  })

  it('labels every issue template with labels the catalogue manages', () => {
    const templates = readdirSync(path.join(root, issueTemplateDir)).filter(f => f.endsWith('.md'))
    expect(templates).not.toEqual([])
    for (const file of templates) {
      const match = read(`${issueTemplateDir}/${file}`).match(/^---\n([\s\S]*?)\n---/)
      expect(match, `${file} has yaml front matter`).not.toBeNull()
      const { labels } = yaml.load(match![1]) as { labels?: string | string[] }
      const names = (Array.isArray(labels) ? labels : String(labels ?? '').split(',')).map(s => s.trim()).filter(Boolean)
      for (const name of names) {
        expect(catalogue.has(name), `${file}: ${name}`).toBe(true)
      }
    }
  })
})
