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

## Testing

| Command | What it runs |
|---------|--------------|
| `npm test` | The whole Vitest suite |
| `npm run test:coverage` | The suite with v8 coverage; CI enforces the thresholds in `vitest.config.mjs` (lines 99, branches 99, functions 99, statements 99, a floor set just under what `main` reaches) |
| `npx vitest run __tests__/bundle` | Only the bundle acceptance harness |
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

### Mutation checks

Line coverage says a test *reached* a statement, not that it would notice the
statement changing. `npm run test:mutation` runs [StrykerJS](https://stryker-mutator.io/docs/stryker-js/introduction/)
(`stryker.config.mjs`) over a small default set of merge-decision code —
`src/utils/mergeGate.ts`, `src/utils/labelMatch.ts`, `src/labels/hold.ts` and
`src/utils/duration.ts` — where a surviving mutant means a pull request could
merge, or be held, for the wrong reason. It is a bounded local check, not a CI
gate: the full suite takes minutes per mutant set, so there is no `break`
threshold and nothing fails a push.

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
