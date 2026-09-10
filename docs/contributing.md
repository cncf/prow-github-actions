# Contributing

Contributions are welcome! Open an issue or pull request against
[cncf/prow-github-actions](https://github.com/cncf/prow-github-actions).
All commits must be signed off (`git commit -s`) to satisfy the DCO check.

## Development

```sh
npm ci
npm run all   # build, lint, pack the dist/ bundle, and test
```

The action runs from the committed `dist/index.js` (an `ncc` bundle of `src/`).
Any change to `src/` must be followed by `npm run pack`, and the resulting
`dist/index.js` committed alongside it; CI fails if `dist/` is out of date.

`tsc` compiles `src/` to ES modules under `lib/`, and `ncc` bundles those into
the CommonJS `dist/index.js` that the runner executes; `package.json`
intentionally has no `"type": "module"`, since Node would then refuse to load
the bundle. Never import from `@actions/github/lib/*` (only `.` and
`./lib/utils` are exported); the `Context` type lives in `src/utils/context.ts`.

## Testing

| Command | What it runs |
|---------|--------------|
| `npm test` | The whole Vitest suite |
| `npm run test:coverage` | The suite with v8 coverage and the thresholds in `vitest.config.mjs` |
| `npx vitest run __tests__/bundle` | Only the bundle acceptance harness |

Unit tests under `__tests__/` import `src/` directly and mock the GitHub API
with [msw](https://mswjs.io/). The acceptance harness in `__tests__/bundle/`
instead executes the committed `dist/index.js` as a child process against a
fake GitHub API on loopback (via `GITHUB_API_URL`), asserting on the HTTP
requests it makes, its exit code, and its `::error::` output. Because it tests
the committed bundle, run `npm run pack` before it (`npm run all` does this).
In CI the suite runs before the `dist/` freshness check, which is fine: the
check then proves that the bundle the harness just exercised matches `src/`.
