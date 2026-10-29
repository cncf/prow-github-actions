import { existsSync, readdirSync, readFileSync } from 'node:fs'
import * as path from 'node:path'

import { describe, expect, it } from 'vitest'
import { root } from './utils/workflowYaml'

// Every `/* v8 ignore */` hint in src/ hides its arm from BOTH coverage runs: the
// bundle run it was written for (`npm run test:coverage:e2e`, where the arm is
// unreachable from dist/index.js) and the unit run (`npm run test:coverage`,
// same provider, same hints). So the unit floor cannot notice when the test the
// hint says drives the arm is deleted or stops reaching it — config.ts still
// reports 100 % lines with configBlunderbussDelay.test.ts and configSweep.test.ts
// removed. This file pins the part of that promise that can be checked
// statically: every hint states a reason, every arm-level hint names the unit
// test that drives it (or is listed below), that test exists and imports the
// hinted module, and every export inside an ignored block is still exercised
// by a test.

const srcDir = path.join(root, 'src')
const testsDir = path.join(root, '__tests__')

interface Hint {
  file: string
  line: number
  kind: 'next' | 'start' | 'stop'
  reason: string
}

function listFiles(dir: string, ext: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith(ext))
    .map(entry => path.relative(root, path.join(entry.parentPath, entry.name)))
    .sort()
}

const sourceFiles = listFiles(srcDir, '.ts')
const testFiles = listFiles(testsDir, '.ts')
const testTexts = new Map(testFiles.map(file => [file, readFileSync(path.join(root, file), 'utf8')]))

const hintPattern = /\/\*\s*v8 ignore (next|start|stop)\b([^*]*)\*\//g

function hintsIn(file: string): Hint[] {
  const text = readFileSync(path.join(root, file), 'utf8')
  const hints: Hint[] = []
  for (const match of text.matchAll(hintPattern)) {
    const line = text.slice(0, match.index).split('\n').length
    hints.push({ file, line, kind: match[1] as Hint['kind'], reason: match[2].trim() })
  }
  return hints
}

const hints = sourceFiles.flatMap(hintsIn)
const armHints = hints.filter(hint => hint.kind === 'next')

/**
 * Arm-level hints whose driving test is not named in the hint text. The comment
 * ships into dist/index.js, so naming the test there means repacking the bundle;
 * until then the driver is recorded here. Keyed by `file:line`.
 */
const driversOutsideTheHint: Record<string, string> = {
  // "a binding refused with a non-Error value fails the command with its string form"
  'src/labels/lgtm.ts:65': '__tests__/label/lgtm.test.ts',
}

/** `__tests__/**\/<name>.test.ts` for the `<name>.test.ts drives it` clause of a hint */
function citedTest(hint: Hint): string | undefined {
  const cited = /(\S+\.test\.ts) drives it/.exec(hint.reason)?.[1]
  if (cited === undefined)
    return driversOutsideTheHint[`${hint.file}:${hint.line}`]
  return testFiles.find(file => path.basename(file) === cited)
}

/** `src/utils/config` for `src/utils/config.ts`: the specifier a test imports the module by, less its leading `../`s */
function moduleSpecifier(file: string): string {
  return file.replace(/\.ts$/, '')
}

function importsModule(testFile: string, sourceFile: string): boolean {
  const text = testTexts.get(testFile) ?? ''
  const specifier = moduleSpecifier(sourceFile)
  return new RegExp(`from '(?:\\.\\./)+${specifier}'`).test(text)
}

/** the names exported between a `start` hint and its `stop` */
function exportedNames(file: string, start: number, stop: number): string[] {
  const lines = readFileSync(path.join(root, file), 'utf8').split('\n').slice(start, stop - 1)
  return lines.flatMap(line => /^export (?:async function|function|const|let) (\w+)\b/.exec(line)?.[1] ?? [])
}

describe('v8 ignore hints in src/', () => {
  it('exist where this guard expects them, so a hint-free tree does not pass vacuously', () => {
    expect(hints.length).toBeGreaterThan(0)
    expect(armHints.length).toBeGreaterThan(0)
    expect(hints.some(hint => hint.kind === 'start')).toBe(true)
  })

  // a `stop` only closes its block; the reason lives on the `start`
  it.each(hints.filter(hint => hint.kind !== 'stop').map(hint => [`${hint.file}:${hint.line}`, hint] as const))('%s states a reason after --', (_at, hint) => {
    expect(hint.reason).toMatch(/^-- \S/)
  })

  describe('arm-level hints (ignore next)', () => {
    it.each(armHints.map(hint => [`${hint.file}:${hint.line}`, hint] as const))('%s names the unit test that drives the ignored arm', (_at, hint) => {
      // either `<name>.test.ts drives it` in the hint or an entry in driversOutsideTheHint
      expect(citedTest(hint), `${hint.reason}\n— no __tests__/**/<name>.test.ts named, or the named file does not exist`).toBeDefined()
    })

    it.each(armHints.map(hint => [`${hint.file}:${hint.line}`, hint] as const))('%s is driven by a test that imports the hinted module', (_at, hint) => {
      const test = citedTest(hint)
      if (test === undefined)
        return // reported by the previous case
      // the recorded drivers reach their arm through the dispatcher rather than a direct import
      if (`${hint.file}:${hint.line}` in driversOutsideTheHint) {
        expect(existsSync(path.join(root, test))).toBe(true)
        return
      }
      expect(importsModule(test, hint.file), `${test} does not import ${moduleSpecifier(hint.file)}`).toBe(true)
    })

    it('records out-of-hint drivers only for hints that still exist and still name no test', () => {
      for (const [at, driver] of Object.entries(driversOutsideTheHint)) {
        const [file, line] = at.split(':')
        const hint = armHints.find(candidate => candidate.file === file && candidate.line === Number(line))
        expect(hint, `${at} is not an \`ignore next\` hint any more; drop or move the entry`).toBeDefined()
        expect(hint?.reason, `${at} now names its test; drop the entry`).not.toMatch(/\.test\.ts drives it/)
        expect(testFiles, `${driver} does not exist`).toContain(driver)
      }
    })
  })

  describe('block hints (ignore start / stop)', () => {
    const blocks = sourceFiles.flatMap((file) => {
      const own = hintsIn(file)
      return own.filter(hint => hint.kind === 'start').map((start) => {
        const stop = own.find(hint => hint.kind === 'stop' && hint.line > start.line)
        return { start, stop }
      })
    })

    it('pair every start with a stop in the same file, and leave no stop without a start', () => {
      for (const { start, stop } of blocks)
        expect(stop, `${start.file}:${start.line} has no matching stop`).toBeDefined()
      for (const file of sourceFiles) {
        const own = hintsIn(file)
        expect(own.filter(hint => hint.kind === 'stop').length).toBe(own.filter(hint => hint.kind === 'start').length)
      }
    })

    // a block is ignored because dist/index.js never reaches it (a test-only hook, an adapter the
    // action does not ship); the unit suite is then the only thing that runs it, so each export
    // in the block must be named by some test
    it.each(blocks.map(block => [`${block.start.file}:${block.start.line}`, block] as const))('%s exports only names that some test exercises', (_at, { start, stop }) => {
      const names = exportedNames(start.file, start.line, stop?.line ?? start.line)
      expect(names.length, 'no export between start and stop').toBeGreaterThan(0)
      for (const name of names) {
        const users = testFiles.filter(file => new RegExp(`\\b${name}\\b`).test(testTexts.get(file) ?? ''))
        expect(users, `${name} is ignored as unreachable from the bundle but no test exercises it`).not.toEqual([])
      }
    })
  })
})
