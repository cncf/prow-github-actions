import { defineConfig, mergeConfig } from 'vitest/config'
import base from './vitest.config.mjs'

// `npm run test:coverage:e2e`: runs __tests__/bundle against a source-mapped bundle in
// .coverage-bundle/ so the child process's V8 hits are remapped onto src/**/*.ts.
// The result is end-to-end-only coverage of src/. It is reported separately from
// `npm run test:coverage` (unit) on purpose: the two runs transform src/ differently
// (vite vs. tsc+webpack), so their statement maps differ and a line-level merge
// would inflate the totals instead of combining them.
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
