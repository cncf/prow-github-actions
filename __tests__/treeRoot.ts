import * as path from 'node:path'

// Stryker copies the tree into `<root>/.stryker-tmp/sandbox-<id>/` and runs the suite from
// there, with every mutated file instrumented. A test that reads a src/ file as text to compare
// it with the documentation must read the tree's copy, not the sandbox's: the instrumented form
// (`'/assign': stryMutAct_9fa48("1") ? () => undefined : (stryCov_9fa48("1"), context => assign(context)),`)
// matches none of the patterns those tests look for, and the dry run fails before any mutant is tested.
const sandboxSegment = /[\\/]\.stryker-tmp[\\/]sandbox-[^\\/]+(?=[\\/]|$)/

/**
 * The repository root for a test in `__tests__/`, whether the file runs from the tree or from a
 * Stryker sandbox copy of it.
 *
 * @param testsDir - the `__dirname` of the calling test, `<root>/__tests__`
 */
export function treeRoot(testsDir: string): string {
  const match = sandboxSegment.exec(testsDir)
  if (match === null) {
    return path.resolve(testsDir, '..')
  }
  return testsDir.slice(0, match.index)
}
