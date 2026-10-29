import { readdirSync, readFileSync, statSync } from 'node:fs'
import * as path from 'node:path'
import Ajv from 'ajv/dist/2020'
import * as yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'

import { approveSettings } from '../src/plugins/approve'
import { blunderbussSettings } from '../src/plugins/blunderbuss'
import { lgtmSettings } from '../src/plugins/lgtmBinding'
import {
  isMapping,
  mergeProwConfig,
  parseProwConfig,
  resolveAuthorization,
  resolveHoldLabel,
  resolveSweepLookback,
  resolveTide,
} from '../src/utils/config'
import { parseOwners } from '../src/utils/owners'

// Every fenced yaml block in the guides is one of three things a reader will
// paste somewhere: a prow.yaml (or a fragment of one), an OWNERS file, or a
// workflow. configurationDocs.test.ts holds the docs/configuration.md example
// to the code's defaults; this file feeds every block in every guide to the
// same parsers so an example the code would reject, or silently ignore, cannot
// stay in the docs. Workflows are covered by workflows.test.ts and version.test.ts.
// Unknown top-level keys and unknown section fields are only `core.debug`ged
// by parseProwConfig, so parsing alone is not enough: the field names are
// checked against what the resolvers know, the way configuration.md's tables are.

const root = path.resolve(__dirname, '..')

function walk(dir: string): string[] {
  return readdirSync(path.join(root, dir)).flatMap((entry) => {
    const rel = path.posix.join(dir, entry)
    return statSync(path.join(root, rel)).isDirectory() ? walk(rel) : [rel]
  })
}

const files = [
  'README.md',
  ...walk('docs').filter(file => file.endsWith('.md') && !file.startsWith('docs/releases/')),
]

interface Block {
  /** `docs/examples.md:22`, the line of the opening fence */
  at: string
  text: string
  /** the paragraph introducing the block, which says what kind of file it is */
  intro: string
}

function yamlBlocks(file: string): Block[] {
  const lines = readFileSync(path.join(root, file), 'utf8').split('\n')
  const blocks: Block[] = []
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith('```yaml')) {
      continue
    }
    const end = lines.indexOf('```', i + 1)
    expect(end, `${file}:${i + 1}: unterminated yaml fence`).toBeGreaterThan(i)
    let start = i - 1
    while (start >= 0 && lines[start].trim() === '') {
      start--
    }
    const intro: string[] = []
    while (start >= 0 && lines[start].trim() !== '' && !lines[start].startsWith('```')) {
      intro.unshift(lines[start--])
    }
    blocks.push({ at: `${file}:${i + 1}`, text: lines.slice(i + 1, end).join('\n'), intro: intro.join('\n') })
    i = end
  }
  return blocks
}

const empty = { ...mergeProwConfig({}, {}), sources: [] }

/** the field names each section accepts, read off what the resolvers return for an empty section */
const sectionFields: Record<string, string[]> = {
  tide: Object.keys(resolveTide({}, '')),
  hold: ['label'],
  blunderbuss: Object.keys(blunderbussSettings(empty)),
  approve: Object.keys(approveSettings(empty)),
  lgtm: Object.keys(lgtmSettings(empty)),
  sweep: ['lookback'],
  authorization: Object.keys(resolveAuthorization({})),
}

// what parseOwners reads, plus the Prow keys docs/commands.md says are accepted and ignored
const ownersKeys = ['approvers', 'reviewers', 'emeritus_approvers', 'emeritus_reviewers', 'filters', 'labels', 'options']
const workflowKeys = ['on', 'jobs', 'permissions', 'concurrency', 'steps', 'runs-on']

type Kind = 'workflow' | 'owners' | 'prow' | 'helm'

/** a job's `steps:` list quoted on its own, e.g. `- uses: cncf/prow-github-actions@v3` */
function isStepList(loaded: unknown): boolean {
  return Array.isArray(loaded) && loaded.length > 0 && loaded.every(step => isMapping(step) && ('uses' in step || 'run' in step))
}

// the new-form prow.yaml sections other than `labels`
const prowSections = Object.keys(mergeProwConfig({}, {})).filter(key => key !== 'labels')

/**
 * An OWNERS block is told apart by the prose that introduces it, or by its own
 * leading comment (`# sdk/OWNERS`), rather than by its keys: a legacy-form
 * prow.yaml is also a mapping of lists, so a typo in `approvers` would otherwise
 * make the block a perfectly valid label section.
 */
function isOwners(block: Block): boolean {
  const comment = block.text.split('\n')[0]
  return /OWNERS|`approvers`|`reviewers`/.test(block.intro) || (comment.startsWith('#') && comment.includes('OWNERS'))
}

/** a Helm values example for charts/prow-github-app: its keys are the chart's top-level values */
const chartDir = path.join(root, 'charts', 'prow-github-app')
const chartDefaults = yaml.load(readFileSync(path.join(chartDir, 'values.yaml'), 'utf8')) as Record<string, unknown>
const chartSchema = JSON.parse(readFileSync(path.join(chartDir, 'values.schema.json'), 'utf8')) as object
const validateValues = new Ajv({ allErrors: true, strict: false }).compile(chartSchema)

function isHelmValues(loaded: Record<string, unknown>): boolean {
  const keys = Object.keys(loaded)
  return keys.length > 0 && keys.every(key => key in chartDefaults)
}

function classify(block: Block, loaded: unknown): Kind {
  if (isStepList(loaded) || !isMapping(loaded)) {
    return 'workflow'
  }
  if (isHelmValues(loaded)) {
    return 'helm'
  }
  const keys = Object.keys(loaded)
  if (keys.some(key => workflowKeys.includes(key))) {
    return 'workflow'
  }
  if (keys.some(key => prowSections.includes(key))) {
    return 'prow'
  }
  return isOwners(block) ? 'owners' : 'prow'
}

const blocks = files.flatMap(yamlBlocks)

describe('every fenced yaml block in the guides', () => {
  it('finds the blocks', () => {
    expect(blocks.length).toBeGreaterThan(30)
    expect(blocks.map(block => block.at)).toContain('docs/examples.md:22')
  })

  describe.each(blocks)('$at', (block) => {
    const { at, text } = block
    // js-yaml reads `on:` as the string key `on` under the default (1.2 core) schema
    const loaded: unknown = yaml.load(text)

    it('is a yaml mapping or a list of workflow steps', () => {
      expect(isMapping(loaded) || isStepList(loaded), `${at}: ${JSON.stringify(loaded)}`).toBe(true)
    })

    const doc = isMapping(loaded) ? loaded : {}
    const kind = classify(block, loaded)

    it.runIf(kind === 'helm')('is a values fragment the chart schema accepts on top of the defaults', () => {
      const merged = { ...chartDefaults, ...doc, github: { ...(chartDefaults.github as object), appId: '1', privateKey: 'k', webhookSecret: 's', ...((doc.github as object | undefined) ?? {}) } }
      expect(validateValues(merged), `${at}: ${JSON.stringify(validateValues.errors)}`).toBe(true)
    })

    it.runIf(kind === 'owners')('parses as an OWNERS file naming somebody, with no key parseOwners would skip', () => {
      for (const key of Object.keys(doc)) {
        expect(ownersKeys, `${at}: unknown OWNERS key '${key}'`).toContain(key)
      }
      const owners = parseOwners(at, text)
      expect([...owners.approvers, ...owners.reviewers].length, at).toBeGreaterThan(0)
    })

    it.runIf(kind === 'prow')('parses as a prow configuration the resolvers accept', () => {
      const parsed = parseProwConfig(at, text)
      const config = { ...mergeProwConfig({}, parsed), sources: [at] }

      expect(Object.keys(parsed).length, `${at}: parses to nothing`).toBeGreaterThan(0)
      // parseProwConfig only debugs an unknown top-level key; here it is a typo
      for (const key of Object.keys(doc)) {
        expect(key in config || (parsed.labels !== undefined && key in parsed.labels), `${at}: unknown top-level key '${key}'`).toBe(true)
      }
      // the section normalizers drop unknown fields; here they are typos too
      for (const [section, fields] of Object.entries(sectionFields)) {
        const raw = doc[section]
        if (section in parsed && isMapping(raw)) {
          for (const field of Object.keys(raw)) {
            expect(fields, `${at}: unknown field '${section}.${field}'`).toContain(field)
          }
        }
      }

      resolveTide(config.tide, '')
      resolveTide(config.tide, '', { hasOwners: true })
      resolveHoldLabel(config.hold)
      resolveSweepLookback(config.sweep)
      resolveAuthorization(config.authorization)
      blunderbussSettings(config)
      approveSettings(config)
      lgtmSettings(config)
    })
  })
})
