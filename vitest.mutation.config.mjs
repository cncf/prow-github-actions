import { defineConfig, mergeConfig } from 'vitest/config'
import base from './vitest.config.mjs'

// `npm run test:mutation` (stryker.config.mjs): the Vitest run Stryker drives
// for each mutant. The bundle acceptance harness is left out because it
// executes the committed dist/index.js in a child process, so no mutation of
// src/ can ever reach it and every one of its tests would only add runtime to
// each mutant. Coverage is off: Stryker instruments the mutated files itself,
// and a threshold failure from an instrumented partial run would be reported
// as a test failure and kill mutants for the wrong reason.
export default mergeConfig(base, defineConfig({
  plugins: [
    {
      // Stryker selects the tests that reach a mutant by assigning
      // `project.config.testNamePattern` a regex of their names joined with a
      // single space ("suite test"), but Vitest 5 matches that pattern against
      // `fullTestName`, which joins the chain with " > " ("suite > test"), so
      // nothing inside a describe() matches and every mutant would be reported
      // Survived with 0 tests run (stryker-mutator/stryker-js#6210, unfixed in
      // @stryker-mutator/vitest-runner 10.0.0). Until that fix ships, rewrite
      // each space in the assigned pattern to accept either separator; a test
      // whose own name contains " > " would at worst run for a mutant it does
      // not reach.
      name: 'stryker-vitest5-test-name-separator',
      configureVitest({ project }) {
        let pattern = project.config.testNamePattern
        Object.defineProperty(project.config, 'testNamePattern', {
          configurable: true,
          enumerable: true,
          get: () => pattern,
          set: (value) => {
            pattern = value instanceof RegExp
              ? new RegExp(value.source.replace(/ /g, '(?: > | )'), value.flags)
              : value
          },
        })
      },
    },
  ],
  test: {
    exclude: ['**/node_modules/**', '__tests__/bundle/**'],
    coverage: { enabled: false },
  },
}))
