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

/**
 * the suites known to read src/ as text: a floor for the scan below, so a regex that stops
 * matching them cannot make the gate pass with nothing to check
 */
const knownReaders = [
  '__tests__/commands.test.ts',
  '__tests__/jobsDocs.test.ts',
  '__tests__/worker/entryPoints.test.ts',
  '__tests__/worker/wranglerConfig.test.ts',
  '__tests__/workflows.test.ts',
]

/** the one module a suite may take `root` from instead of defining it, and the import that does so */
const sharedRoot = '__tests__/utils/workflowYaml.ts'
const importsSharedRoot = /import \{[^}]*\broot\b[^}]*\} from '(?:\.\.\/)*(?:\.\/)?utils\/workflowYaml'/

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
const importsTreeRoot = /import \{ treeRoot \} from '(?:\.\.\/)*(?:\.\/)?treeRoot'/
const definesRoot = /\bconst root = treeRoot\(/

/** every suite outside the bundle harness that names a src/ file and reads files, itself or through the shared root */
const srcTextReaders = testFiles(testsDir)
  .filter(file => !file.startsWith('__tests__/bundle/'))
  .filter(file => !notPatternReaders.includes(file))
  .filter((file) => {
    const source = text(file)
    return namesSrc.test(source) && (readsFiles.test(source) || importsSharedRoot.test(source))
  })

describe('tests that read src/ as text', () => {
  it('include the known readers, so the scan cannot go quiet', () => {
    expect(srcTextReaders).toEqual(expect.arrayContaining(knownReaders))
  })

  it('each take their root from treeRoot(), directly or through the shared root', () => {
    for (const suite of srcTextReaders) {
      const source = text(suite)
      const rootModule = definesRoot.test(source) ? suite : importsSharedRoot.test(source) ? sharedRoot : undefined
      expect(rootModule, `${suite} reads src/ as text but neither defines root through treeRoot() nor imports it from ${sharedRoot}`).toBeDefined()
      const rootSource = text(rootModule as string)
      expect(rootSource, `${rootModule} (root of ${suite}) must import treeRoot`).toMatch(importsTreeRoot)
      expect(rootSource, `${rootModule} (root of ${suite}) must define root through treeRoot()`).toMatch(definesRoot)
    }
  })
})
