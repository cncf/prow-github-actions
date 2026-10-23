// @ts-check
/**
 * `npm run test:mutation` — bounded mutation checks, see docs/contributing.md
 * ("Mutation checks"). The default `mutate` set is the merge-decision code,
 * where a surviving mutant means a pull request could merge or be held for the
 * wrong reason; pass `--mutate <glob>` to probe any other file. This is a
 * reproducible local and nightly-style check, not a per-push gate, so no
 * `break` threshold is set.
 *
 * @type {import('@stryker-mutator/api/core').PartialStrykerOptions}
 */
export default {
  testRunner: 'vitest',
  vitest: { configFile: 'vitest.mutation.config.mjs' },
  // perTest runs only the tests that reach each mutant; a mutant no test reaches
  // is reported as "no coverage" rather than run against the whole suite.
  coverageAnalysis: 'perTest',
  mutate: [
    'src/utils/mergeGate.ts',
    'src/utils/labelMatch.ts',
    'src/labels/hold.ts',
    'src/utils/duration.ts',
  ],
  ignorePatterns: ['dist', 'lib', 'coverage', 'coverage-e2e', '.coverage-bundle', 'reports'],
  // The incremental file lets a re-run after a test change re-test only the
  // mutants whose source or covering tests moved.
  incremental: true,
  incrementalFile: 'reports/mutation/incremental.json',
  reporters: ['clear-text', 'progress', 'html', 'json'],
  htmlReporter: { fileName: 'reports/mutation/index.html' },
  jsonReporter: { fileName: 'reports/mutation/report.json' },
  clearTextReporter: { allowColor: false, logTests: true, maxTestsToLog: 3 },
  thresholds: { high: 90, low: 75, break: null },
  tempDirName: '.stryker-tmp',
  timeoutMS: 60_000,
}
