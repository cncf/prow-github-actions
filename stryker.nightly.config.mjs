// @ts-check
import base from './stryker.config.mjs'

/**
 * `npm run test:mutation:nightly` — the merge-decision set of
 * stryker.config.mjs, plus the code that performs the merge, run as the
 * scheduled `mutation` job of .github/workflows/test.yml. No incremental file
 * (CI has no previous run to reuse), and a `break` score just under what
 * `main` reaches (96 % at ed3bb42 over the default set, six equivalent
 * survivors; 96.1 % at 424fb95 with tide.ts and mergeQueue.ts, 24 more
 * reviewed survivors) so a new behavioural survivor fails the nightly run
 * instead of waiting for someone to run the check by hand. See
 * docs/contributing.md ("Mutation checks").
 *
 * @type {import('@stryker-mutator/api/core').PartialStrykerOptions}
 */
export default {
  ...base,
  // tide.ts decides and performs the merge and mergeQueue.ts enqueues it; they
  // stay out of the local default set only because they add ~620 mutants
  // (~25 minutes), which the scheduled job can afford.
  mutate: [...base.mutate, 'src/plugins/tide.ts', 'src/utils/mergeQueue.ts'],
  incremental: false,
  reporters: ['clear-text', 'json'],
  thresholds: { high: 90, low: 75, break: 95 },
}
