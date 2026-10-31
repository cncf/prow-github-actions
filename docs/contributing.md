# Contributing

Contributions are welcome! Open an issue or pull request against
[cncf/prow-github-actions](https://github.com/cncf/prow-github-actions).
All commits must be signed off (`git commit -s`) to satisfy the DCO check.

## Development

Node 24 or newer is required. `package.json` names Node 24 in
`devEngines.runtime` so that every `actions/setup-node` step in CI installs the
same major that `action.yml` runs the bundle under (`runs.using: node24`);
`npm ci` on a newer Node only warns.

```sh
npm ci
npm run all   # build, lint, pack the dist/ bundle, and test
```

Note that `npm run all` runs `lint:fix` first, which rewrites files in place.

`npm run build` compiles `src/` only (`tsconfig.json` excludes `__tests__/`),
and Vitest strips types without checking them, so a test whose fixture has
drifted from the type it claims to be still runs. `npm run typecheck`
(`tsc -p tsconfig.test.json`) type-checks `src/` and `__tests__/` together
without emitting; CI runs it in `build-test`, so run it after changing an
exported type or a test fixture. `src/server/worker.ts` is excluded there and
checked by `npm run build` (`tsconfig.worker.json`) with the Cloudflare types.

The action runs from the committed `dist/index.js` (an `ncc` bundle of `src/`).
Any change to `src/` must be followed by `npm run pack`, and the resulting
`dist/index.js` committed alongside it; CI fails if `dist/` is out of date.

`tsc` compiles `src/` to ES modules under `lib/` (which is gitignored), and
`ncc` bundles those into the CommonJS `dist/index.js` that the runner executes;
`package.json` intentionally has no `"type": "module"`, since Node would then
refuse to load the bundle. Never import from `@actions/github/lib/*` (only `.`
and `./lib/utils` are exported); the `Context` type lives in
`src/utils/context.ts`.

[Dependabot](../.github/dependabot.yml) keeps npm dependencies and pinned
actions up to date on a weekly schedule. A bump of a bundled runtime dependency
changes `dist/index.js`, so its pull request fails the `dist/` check until a
maintainer runs `npm run pack` on the Dependabot branch and pushes the result.

This repository runs the bot on itself through the reusable workflow
([`prow.yml`](../.github/workflows/prow.yml)) from a single caller,
[`prow-bot.yml`](../.github/workflows/prow-bot.yml), in the
[`pull_request` install mode](./installing.md#without-pull_request_target): fork pull requests
are handled by the scheduled `sweep` job (every 20 minutes). A pull request that touches
either file is exercised by its own bot run. `__tests__/workflows.test.ts` checks
that the reusable workflow, its callers and the [install templates](../templates)
stay in step with `action.yml` and the label catalogue.

Issues the Hive quality agent (`hivecommons-hive[bot]`) opens carry no kind label, so
[`agent-issues.yml`](../.github/workflows/agent-issues.yml) adds `kind/cleanup` to each
one — after the bot's own run on the `opened` event has finished, since a label applied
with `github.token` raises no event the bot could react to — and clears the `needs-kind`
label and reminder comment the bot left in the meantime.

## Testing

| Command | What it runs |
|---------|--------------|
| `npm test` | The whole Vitest suite |
| `npm run test:coverage` | The suite with v8 coverage; CI enforces the thresholds in `vitest.config.mjs` (lines 99, branches 99, functions 99, statements 99, a floor set just under what `main` reaches) |
| `npx vitest run __tests__/bundle` | Only the bundle acceptance harness |
| `npm run test:shuffle` | The whole suite with the tests of every file in a random order (`--sequence.shuffle`; pass `--sequence.seed=<n>` to repeat an order); the `shuffle` job runs it on every pull request; see "Test order" below |
| `npm run test:mutation` | StrykerJS over the merge-decision code, locally; see "Mutation checks" below |
| `npm run test:mutation:nightly` | The same set as the `mutation` job runs on the daily schedule (`stryker.nightly.config.mjs`): no incremental file, and a `break` score of 95 |
| `npm run test:coverage:e2e` | Only the bundle acceptance harness, run against a source-mapped bundle built from `__tests__/bundle/coverageEntry/` into `.coverage-bundle/` so its hits are reported against `src/`, written to `coverage-e2e/` so it never overwrites the unit run's `coverage/` (ncc's map is line-only, so the build also emits tsc's per-file maps into `.coverage-bundle/tsc/` and `coverageEntry/remap.mjs` composes their columns into it; without that, inner lines of a multi-line expression that tsc flattens onto one JS line report 0 hits). This is end-to-end-only coverage and is deliberately reported separately from `test:coverage`: the unit run already reaches every line, so a union would say nothing about what the bundle exercises, and the two runs' statement and branch maps come from different transforms (vite vs. tsc+webpack) and do not combine. Fails below 99 % lines / 99 % branches / 99 % functions / 99 % statements (`vitest.e2e-coverage.config.mjs`), a floor set just under what `main` reaches so a scenario that stops driving a `src/` path is caught |

Unit tests under `__tests__/` import `src/` directly and mock the GitHub API
with [msw](https://mswjs.io/). The acceptance harness in `__tests__/bundle/`
instead executes the committed `dist/index.js` as a child process against a
fake GitHub API on loopback (via `GITHUB_API_URL`), asserting on the HTTP
requests it makes, its exit code, and its `::error::` output. Because it tests
the committed bundle, run `npm run pack` before it (`npm run all` does this).
In CI the suite runs before the `dist/` freshness check, which is fine: the
check then proves that the bundle the harness just exercised matches `src/`.

`__tests__/setup.ts` tightens `toThrow`: out of the box, `toThrow(message)`
passes when the thrown value is `undefined` or `null`, because chai compares
the message only against a truthy error
([vitest-dev/vitest#7260](https://github.com/vitest-dev/vitest/issues/7260)).
A helper that should build an `Error` but returns nothing — what a Stryker
block mutant makes of `malformedSection` in `src/utils/config.ts` — would
otherwise satisfy every message assertion in the suite. With the setup hook,
a nullish throw fails `toThrow` and `.rejects.toThrow` whatever the argument;
`__tests__/setupToThrowGuard.test.ts` pins that.

### Phantom "uncovered" branches after an `await`

The unit run lists four branches as uncovered that every test run in fact
drives: `close.ts:39`, `reopen.ts:36`, `approve.ts:504` and `auth.ts:225`
(it reports 1652/1656 branches because of them; the e2e run repeats the last
two). Each is an `if` with no `else` whose condition was assigned from an
expression in which an `await` is only sometimes reached (`a || (await b())`,
or a ternary with an `await` in each arm). V8 opens a fresh block-count range
at the point an async function resumes, so the range enclosing the `if` counts
only the calls that resumed from that particular `await`, while the then-block
is counted correctly; the implicit else that the v8 provider derives as
"enclosing minus then" then comes out as zero or negative. The giveaway is a
negative hit count in `lcov.info`, which a well-formed `BRDA` record cannot
carry:

```sh
awk '/^SF:/{f=$0} /^BRDA:/{split($0,a,","); if (a[4] ~ /^-/) print f, $0}' coverage/lcov.info
```

Do not add tests, `/* v8 ignore */` markers or a lower branch threshold for
these: the arm is covered, and an ignore marker would hide a real miss on the
same line. A minimal reproduction against `@vitest/coverage-v8` 5.0.4 was
filed upstream as [vitest-dev/vitest#11690](https://github.com/vitest-dev/vitest/issues/11690)
and reproduced on Node 24.22.0 (V8 13.6.233.17-node.57), Vitest 5.0.4,
Vite 8.3.4 and `ast-v8-to-istanbul` 1.0.7:

```ts
export async function gate(a: boolean, b: boolean): Promise<string> {
  const ok = a || (await Promise.resolve(b))
  if (ok)
    return 'yes'
  return 'no'
}
// gate(true, false) ×3, gate(false, true), gate(false, false)
// → BRDA for the `if`: then 4, else -2 (it ran once)
```

In the same reproduction an explicit `else { … }` block, which owns a V8
range of its own, is counted correctly.

### Test order

Vitest runs the tests of a file in source order, so a test that leaves state
behind is only noticed by the tests that happen to follow it. `npm run
test:shuffle` runs every file's tests in a random order (the seed is printed
with the failure; `--sequence.seed=<n>` repeats it); the `shuffle` job of
`test.yml` runs it on every pull request, so an order-dependent test fails
there even when the source order happens to pass. The four ways a test has
leaked into its neighbour here, and how each file now avoids them:

- **A mutated fixture.** The JSON fixtures are imported once per file, so
  `event.comment.body = '/assign @x'` is seen by every later test of the file;
  the test that relied on the fixture's own body then dispatched a different
  command. Either `structuredClone` the fixture before changing it (the cron
  tests' `lgtmPr`) or reset the field in a `beforeEach`.
- **A probe chain outliving its test.** `loadProwConfig` probes the
  organization and repository tiers under `Promise.all`; when the tier a test
  exercises rejects, the other tier's probes keep going after the test's
  `await` has returned, and a probe that starts between two tests is reported —
  by `failTestOnUnhandledRequests`, or by a `request:start` listener — against
  the next one. Waiting for the in-flight count to reach zero does not help,
  because the chain is idle between two of its probes. `utils.configFoundAt`
  serves an empty configuration at the other tier's first probe, so the only
  sibling request is already in flight when the rejection lands.
- **A memo that outlives the test.** Everything a handler memoizes for an
  event — configuration, repository labels, OWNERS trees, warnings already
  shown — lives in the platform's `RunState`, and `__tests__/setup.ts`
  installs a fresh platform before every test, so a test inherits nothing the
  previous one loaded. A test that swaps in its own platform mid-test (or a
  `describe` that needs an empty run between its own tests) calls
  `utils.newRun()`. A file that uses `vi.resetModules()` must import
  `@actions/core` and the module under test fresh together, or the assertion
  spies on a different `core` instance than the one the module warns through.
- **An installation-token request that never settles.** `@octokit/auth-app`
  deduplicates concurrent token requests for one installation in a map that is
  shared by every `createAppAuth` in the process, not one per App. An msw
  handler for `POST /app/installations/{id}/access_tokens` that returns a
  promise which never resolves therefore parks every later mint for that
  installation in the same file, however many receivers the tests build — the
  next test that mints a token hangs until its timeout without issuing a
  request. Hold the handler on a promise the test settles in its `finally`
  (a 500 ends the delivery with no further requests), and wait for the parked
  delivery's failure line before restoring the spies it logs through.

### Mutation checks

Line coverage says a test *reached* a statement, not that it would notice the
statement changing. `npm run test:mutation` runs [StrykerJS](https://stryker-mutator.io/docs/stryker-js/introduction/)
(`stryker.config.mjs`) over a small default set of merge-decision code —
`src/utils/mergeGate.ts`, `src/utils/labelMatch.ts`, `src/labels/hold.ts` and
`src/utils/duration.ts` — where a surviving mutant means a pull request could
merge, or be held, for the wrong reason. It is a bounded check, not a per-push
gate: the suite takes minutes per mutant set, so the local run sets no `break`
threshold and nothing fails a push. The `mutation` job of `test.yml` runs the
same set on the daily schedule (and on `workflow_dispatch`) through
`stryker.nightly.config.mjs`, which fails below a score of 95 — just under
what `main` reaches with its equivalent survivors — and publishes the per-file
tally in the job summary and `reports/mutation/` as an artifact.

```sh
npm run test:mutation                                   # the default set (~150 mutants, ~12 minutes)
npm run test:mutation -- --mutate src/plugins/tide.ts   # any other file; `src/x.ts:10-40` limits the lines
```

Stryker drives Vitest through `vitest.mutation.config.mjs`, which leaves out the
bundle harness (it runs the committed `dist/index.js`, which no mutation of
`src/` can reach) and turns coverage off. With `coverageAnalysis: 'perTest'`
each mutant runs only the tests that reach it, so a mutant no test reaches is
reported as *no coverage* rather than run against the whole suite. Reports land
in `reports/mutation/` (`index.html`, `report.json`); the incremental file there
lets a re-run after a test change re-test only the mutants whose source or
covering tests moved. Both directories are ignored by git.

`vitest.mutation.config.mjs` also carries a shim for
[stryker-mutator/stryker-js#6210](https://github.com/stryker-mutator/stryker-js/issues/6210):
`@stryker-mutator/vitest-runner` 10.0.0 selects a mutant's tests with a
`testNamePattern` of space-joined names, but Vitest 5 matches that pattern
against the ` > `-joined chain, so without the shim every mutant inside a
`describe()` is reported *Survived* with 0 tests run. Remove the shim once a
vitest-runner release carries the fix.

A survivor is a finding only after reading it. Add a test when the mutant
changes an observable effect (a request made or not made, a label applied, a
thrown message a caller reads); record it here instead when it is equivalent
or only changes text nobody asserts on. Reviewed survivors of the default set:

| Mutant | Why it is left |
|--------|----------------|
| `duration.ts:13` `value === ''` → `false` / other string | Equivalent: an empty string matches no duration part, `consumed` stays `0 === value.length`, and `Math.round(0)` is returned either way |
| `hold.ts:26` `getInput('github-token', { required: true })` → `{}` / `false` | `required` is `@actions/core`'s contract, identical at every entry point; the mutant only changes which error a missing token raises |
| `hold.ts:30` `context.payload.comment?.body` → `.comment.body` | Every `issue_comment` event carries `comment`; the two differ only on a payload GitHub never sends |
| `hold.ts:73-74` `present.length === 0` guard and its `core.debug` text | `removeLabels` with an empty list issues no request, so the guard only saves a loop; the debug message is not asserted |
