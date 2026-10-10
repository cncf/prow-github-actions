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
export default mergeConfig(base, defineConfig({
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
      include: ['src/**/*.ts', '.coverage-bundle/index.js'],
      autoAttachSubprocess: true,
      excludeAfterRemap: true,
      thresholds: {
        lines: 0,
        branches: 0,
        functions: 0,
        statements: 0,
      },
    },
  },
}))
