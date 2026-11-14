import { defineConfig, mergeConfig } from 'vitest/config'
import base from './vitest.config.mjs'

// `npm run test:coverage:e2e`: runs __tests__/bundle against a source-mapped bundle in
// .coverage-bundle/ (built from __tests__/bundle/coverageEntry/, whose tsconfig turns
// on `sourceMap`) so the child process's V8 hits are remapped onto src/**/*.ts.
// ncc's map is line-only (webpack `cheap-module-source-map`), so `pack:coverage`
// also emits tsc's per-file maps into .coverage-bundle/tsc/ and runs
// coverageEntry/remap.mjs to compose their columns into index.js.map; otherwise
// a multi-line expression that tsc flattens onto one JS line reports its inner
// lines as 0 hits. The result is end-to-end-only coverage of src/. It is reported separately from
// `npm run test:coverage` (unit) on purpose: the unit run already reaches every line,
// so a union would say nothing about what the bundle exercises, and the two runs'
// statement and branch maps come from different transforms (vite vs. tsc+webpack)
// and do not combine.
const config = mergeConfig(base, defineConfig({
  plugins: [
    {
      // The bundle only ever runs in a child process; vitest never imports it. But
      // because `coverage.include` names it (so the child's V8 hits pass the filter)
      // and the remapped report lists src/ files rather than the bundle, vitest also
      // treats it as an "untested" file and re-converts it through vite's transform.
      // vite composes its own map over index.js.map and lands on slightly different
      // columns, and istanbul's merge gives each unmatched location the hits of its
      // nearest container — so every unreachable arm would inherit its function's
      // count. Refusing the load makes vitest fall back to the raw file + external
      // map, which yields the same locations as the child-process conversion.
      name: 'coverage-bundle-raw',
      enforce: 'pre',
      load(id) {
        if (id.endsWith('/.coverage-bundle/index.js')) {
          throw new Error('.coverage-bundle/index.js is read raw, not transformed by vite')
        }
      },
    },
  ],
  test: {
    env: {
      PROW_BUNDLE_PATH: '.coverage-bundle/index.js',
    },
    coverage: {
      // Own directory so a local or CI e2e run never overwrites the unit run's coverage/.
      reportsDirectory: 'coverage-e2e',
      include: ['src/**/*.ts', '.coverage-bundle/index.js'],
      // this run measures what the action's bundle exercises; the GitHub App adapter
      // and its server are not part of that bundle (unit coverage holds them to 100%)
      exclude: ['src/adapters/app/**', 'src/server/**', 'src/deferred.ts'],
      autoAttachSubprocess: true,
      excludeAfterRemap: true,
      // Regression floor for the bundle-only run, set just under what main reaches
      // (99.84 / 99.66 / 99.82 / 99.85 at 9aa12b8 once the worker stops loading
      // src/ through the setup files, see the setupFiles note below — 572/573
      // functions, the miss being resumeRequiredLabels, which only the App
      // adapter's deferred path calls;
      // 100 / 99.88 / 100 / 100 once blunderbussDelayFailure.test.ts drives the
      // delayed pass's catch, 1686/1688 branches, the two misses being the
      // negative-count await artifacts described in docs/contributing.md;
      // 100 / 99.46 / 100 / 100 at e3119ad; 99.95 / 97.96 / 100 / 99.96 at 1062ce7;
      // 99.54 / 96.25 / 98.79 / 99.56 when first set at d93ecb8) so a scenario that
      // stops exercising a src/ path fails this run instead of silently lowering
      // the figure. A single lost branch is ~0.06 pp and will not cross the floor
      // on its own; the floor bounds drift, it does not detect one-branch
      // regressions. Branches now share the unit run's 99 floor.
      thresholds: {
        lines: 99,
        branches: 99,
        functions: 99,
        statements: 99,
      },
    },
  },
}))

// mergeConfig concatenates `setupFiles`, so the base list is replaced rather than
// extended. `__tests__/setup.ts` imports src/adapters/actions.ts (and through it
// src/platform/index.ts and src/utils/sleep.ts) into every vitest worker; in this
// run the worker's own V8 hits on those vite-transformed modules were merged with
// the bundle's remapped hits, and because the two transforms place a function's
// declaration on different columns istanbul kept both copies. The worker never
// calls platform(), actionsContext() or sleep(), so each was reported as an
// uncovered function (587/591 at 9aa12b8) and platform/index.ts:59-60 carried
// four phantom branch arms. Only the toThrow guard is installed here: the bundle
// runs in a child process, so neither the @actions/core mock nor the platform the
// unit suite installs is needed, and the guard imports nothing from src/.
config.test.setupFiles = ['__tests__/setupToThrowGuard.ts']

export default config
