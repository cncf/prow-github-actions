import { readdirSync, readFileSync } from 'node:fs'
import * as path from 'node:path'

import { describe, expect, it } from 'vitest'
import { root } from './utils/workflowYaml'

// The JSON fixtures under __tests__/fixtures are recorded GitHub payloads that
// tests import by relative path. Nothing else checks that a fixture is still
// imported: a test that drops its import (or is deleted) leaves the payload
// behind as dead data that reads as a tested case, and the next edit to the
// recorded shape has no test to fail. Three such orphans accumulated this way
// (pullCommentEvent, pullReqListFiles, issueListAssignees). This file pins
// that every fixture is named by at least one test or test helper.

const fixturesDir = path.join(root, '__tests__', 'fixtures')
const testsDir = path.join(root, '__tests__')

function listFiles(dir: string, keep: (name: string) => boolean): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile() && keep(entry.name))
    .map(entry => path.join(entry.parentPath, entry.name))
    .sort()
}

const fixtureFiles = listFiles(fixturesDir, name => name.endsWith('.json'))
  .map(file => path.relative(fixturesDir, file).split(path.sep).join('/'))

const referencingTexts = listFiles(testsDir, name => /\.(?:ts|cjs|mjs)$/.test(name))
  .filter(file => !file.startsWith(fixturesDir + path.sep))
  .map(file => readFileSync(file, 'utf8'))

describe('__tests__/fixtures', () => {
  it('holds at least one fixture', () => {
    expect(fixtureFiles.length).toBeGreaterThan(0)
  })

  it.each(fixtureFiles)('%s is imported by a test', (fixture) => {
    const needle = `fixtures/${fixture}`
    const referenced = referencingTexts.some(text => text.includes(needle))
    expect(referenced, `${needle} is imported by no file under __tests__; delete it or import it`).toBe(true)
  })
})
