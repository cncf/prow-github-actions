import { readdirSync, readFileSync } from 'node:fs'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'

import { treeRoot } from './treeRoot'

// A test that reads a src/ file as text and matches patterns against it (the commands a
// dispatcher handles, the inputs the action reads, the env names the Worker dereferences) must
// read the tree's copy. Stryker copies the tree into `.stryker-tmp/sandbox-<id>/`, instruments
// every mutated file there and runs the suite from the copy, and `__tests__/setup.ts` imports
// `src/adapters/actions.ts` and `src/platform/index.ts`, so a probe over either relates every
// test file. An instrumented literal (`stryMutAct_9fa48("1") ? "" : (stryCov_9fa48("1"),
// 'cat-api-key')`) matches none of those patterns and the dry run fails before any mutant is
// tested. treeRoot() resolves the tree from either place; this pins that every such suite takes
// its root from it.

const root = treeRoot(__dirname)
const testsDir = path.join(root, '__tests__')

/** the suites that read src/ as text, each with the module that defines the `root` they read from */
const srcTextReaders: Record<string, string> = {
  '__tests__/commands.test.ts': '__tests__/commands.test.ts',
  '__tests__/jobsDocs.test.ts': '__tests__/jobsDocs.test.ts',
  '__tests__/workflows.test.ts': '__tests__/utils/workflowYaml.ts',
  '__tests__/worker/entryPoints.test.ts': '__tests__/utils/workflowYaml.ts',
  '__tests__/worker/wranglerConfig.test.ts': '__tests__/worker/wranglerConfig.test.ts',
}

/** suites that name src/ files and read files, but do not match code patterns against a src/ file */
const notPatternReaders = [
  // reads `v8 ignore` comments, which instrumentation keeps in place, and strips the sandbox's
  // `// @ts-nocheck` prefix itself; it must read the sandbox copy, as it also reads every test file
  '__tests__/coverageIgnoreHints.test.ts',
  // names the files of the nightly mutation set and reads docs/contributing.md
  '__tests__/mutationConfig.test.ts',
  // builds src/server/main.ts with ncc and reads the bundle it produced, not the source
  '__tests__/server/bundle.test.ts',
  // this file
  '__tests__/treeReads.test.ts',
]

function testFiles(dir: string): string[] {
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.ts'))
    .map(entry => path.relative(root, path.join(entry.parentPath, entry.name)).split(path.sep).join('/'))
    .sort()
}

function text(file: string): string {
  return readFileSync(path.join(root, file), 'utf8')
}

const readsFiles = /\bread(?:File|dir)Sync\(/
const namesSrc = /'src(?:\/[^']*\.ts)?'/

describe('tests that read src/ as text', () => {
  it('each take their root from treeRoot()', () => {
    for (const [suite, rootModule] of Object.entries(srcTextReaders)) {
      const source = text(rootModule)
      expect(source, `${rootModule} (root of ${suite}) must import treeRoot`).toMatch(/import \{ treeRoot \} from '(?:\.\.\/)*(?:\.\/)?treeRoot'/)
      expect(source, `${rootModule} (root of ${suite}) must define root through treeRoot()`).toMatch(/\bconst root = treeRoot\(/)
    }
  })

  it('each still read src/ as text, so the list above does not go stale', () => {
    for (const [suite, rootModule] of Object.entries(srcTextReaders)) {
      const source = text(suite)
      expect(source, `${suite} no longer names a src/ file`).toMatch(namesSrc)
      expect(readsFiles.test(source) || readsFiles.test(text(rootModule)), `${suite} no longer reads files`).toBe(true)
    }
  })

  it('are all listed, so a new one cannot read the Stryker sandbox copy unnoticed', () => {
    const readers = testFiles(testsDir)
      .filter(file => !file.startsWith('__tests__/bundle/'))
      .filter(file => !notPatternReaders.includes(file))
      .filter((file) => {
        const source = text(file)
        return namesSrc.test(source) && (readsFiles.test(source) || source.includes(`from './utils/workflowYaml'`) || source.includes(`from '../utils/workflowYaml'`))
      })
    expect(readers).toEqual(Object.keys(srcTextReaders).sort())
  })
})
