import { defineConfig, mergeConfig } from 'vitest/config'
import base from './vitest.config.mjs'

// `npm run test:coverage:e2e`: runs __tests__/bundle against a source-mapped bundle in
// .coverage-bundle/ (built from __tests__/bundle/coverageEntry/, whose tsconfig turns
// on `sourceMap`) so the child process's V8 hits are remapped onto src/**/*.ts.
// The result is end-to-end-only coverage of src/. It is reported separately from
// `npm run test:coverage` (unit) on purpose: the unit run already reaches every line,
// so a union would say nothing about what the bundle exercises, and the two runs'
// statement and branch maps come from different transforms (vite vs. tsc+webpack)
// and do not combine.
export default mergeConfig(base, defineConfig({
  test: {
    env: {
      PROW_BUNDLE_PATH: '.coverage-bundle/index.js',
    },
    coverage: {
      include: ['src/**/*.ts', '.coverage-bundle/**/*.js'],
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
