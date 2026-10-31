// @ts-check
import base from './stryker.config.mjs'

/**
 * `npm run test:mutation:nightly` — the default merge-decision set of
 * stryker.config.mjs run as the scheduled `mutation` job of
 * .github/workflows/test.yml. Same mutants, no incremental file (CI has no
 * previous run to reuse), and a `break` score just under what `main` reaches
 * (96 % at ed3bb42, six equivalent survivors) so a new behavioural survivor
 * fails the nightly run instead of waiting for someone to run the check by
 * hand. See docs/contributing.md ("Mutation checks").
 *
 * @type {import('@stryker-mutator/api/core').PartialStrykerOptions}
 */
export default {
  ...base,
  incremental: false,
  reporters: ['clear-text', 'json'],
  thresholds: { high: 90, low: 75, break: 95 },
}
