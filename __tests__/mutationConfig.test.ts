import type { PartialStrykerOptions } from '@stryker-mutator/api/core'
import { readFileSync } from 'node:fs'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'

// the configs are JSDoc-typed .mjs files outside tsconfig's `include`, so they import as `any`
// @ts-expect-error TS7016
import untypedBase from '../stryker.config.mjs'
// @ts-expect-error TS7016
import untypedNightly from '../stryker.nightly.config.mjs'

const base = untypedBase as PartialStrykerOptions
const nightly = untypedNightly as PartialStrykerOptions
const baseSet = (base.mutate ?? []).filter((file): file is string => file !== undefined)
const nightlySet = (nightly.mutate ?? []).filter((file): file is string => file !== undefined)

const root = path.resolve(__dirname, '..')
const contributing = readFileSync(path.join(root, 'docs/contributing.md'), 'utf8')

// The nightly set is the local merge-decision set plus the code that performs
// the merge (tide.ts, mergeQueue.ts) and the code that decides the `approved`
// half of it (approve.ts); docs/contributing.md names the same files and the
// same `break` score, so a change to either must move the other.
describe('stryker.nightly.config.mjs', () => {
  it('extends the local merge-decision set', () => {
    expect(nightlySet).toEqual(expect.arrayContaining(baseSet))
  })

  it('adds the files that perform and approve the merge', () => {
    const added = nightlySet.filter(file => !baseSet.includes(file))
    expect(added.sort()).toEqual(['src/plugins/approve.ts', 'src/plugins/tide.ts', 'src/utils/mergeQueue.ts'])
  })

  it('sets the break score docs/contributing.md documents', () => {
    const score = nightly.thresholds?.break
    expect(score).toEqual(expect.any(Number))
    expect(contributing).toContain(`a \`break\` score of ${score}`)
    expect(contributing).toContain(`fails below a score of ${score}`)
  })

  it('is documented file for file', () => {
    for (const file of nightlySet) {
      expect(contributing, `${file} is in the nightly set but docs/contributing.md never names it`).toContain(`\`${file}\``)
    }
  })
})
