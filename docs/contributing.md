# Contributing

Contributions are welcome! Open an issue or pull request against
[cncf/prow-github-actions](https://github.com/cncf/prow-github-actions).
All commits must be signed off (`git commit -s`) to satisfy the DCO check.

## Development

Node 24 or newer is required.

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
| `npm run test:coverage:e2e` | Only the bundle acceptance harness, run against a source-mapped bundle built from `__tests__/bundle/coverageEntry/` into `.coverage-bundle/` so its hits are reported against `src/`, written to `coverage-e2e/` so it never overwrites the unit run's `coverage/` (ncc's map is line-only, so the build also emits tsc's per-file maps into `.coverage-bundle/tsc/` and `coverageEntry/remap.mjs` composes their columns into it; without that, inner lines of a multi-line expression that tsc flattens onto one JS line report 0 hits). This is end-to-end-only coverage and is deliberately reported separately from `test:coverage`: the unit run already reaches every line, so a union would say nothing about what the bundle exercises, and the two runs' statement and branch maps come from different transforms (vite vs. tsc+webpack) and do not combine. Fails below 99 % lines / 97 % branches / 99 % functions / 99 % statements (`vitest.e2e-coverage.config.mjs`), a floor set just under what `main` reaches so a scenario that stops driving a `src/` path is caught |

Unit tests under `__tests__/` import `src/` directly and mock the GitHub API
with [msw](https://mswjs.io/). The acceptance harness in `__tests__/bundle/`
instead executes the committed `dist/index.js` as a child process against a
fake GitHub API on loopback (via `GITHUB_API_URL`), asserting on the HTTP
requests it makes, its exit code, and its `::error::` output. Because it tests
the committed bundle, run `npm run pack` before it (`npm run all` does this).
In CI the suite runs before the `dist/` freshness check, which is fine: the
check then proves that the bundle the harness just exercised matches `src/`.

### Phantom "uncovered" branches after an `await`

The unit run lists four branches as uncovered that every test run in fact
drives: `close.ts:39`, `reopen.ts:36`, `approve.ts:504` and `auth.ts:220`
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
