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
actions up to date on a weekly schedule.

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
| `npm run test:coverage` | The suite with v8 coverage; CI enforces the thresholds in `vitest.config.mjs` (lines 85, branches 83, functions 91, statements 85) |
| `npx vitest run __tests__/bundle` | Only the bundle acceptance harness |

Unit tests under `__tests__/` import `src/` directly and mock the GitHub API
with [msw](https://mswjs.io/). The acceptance harness in `__tests__/bundle/`
instead executes the committed `dist/index.js` as a child process against a
fake GitHub API on loopback (via `GITHUB_API_URL`), asserting on the HTTP
requests it makes, its exit code, and its `::error::` output. Because it tests
the committed bundle, run `npm run pack` before it (`npm run all` does this).
In CI the suite runs before the `dist/` freshness check, which is fine: the
check then proves that the bundle the harness just exercised matches `src/`.

## End-to-end tests

The [`End-to-end (sandbox)`](../.github/workflows/e2e.yml) workflow runs nightly and on
demand (`workflow_dispatch`, which can target any branch). `npm run e2e`
([`e2e/sandbox.mts`](../e2e/sandbox.mts)) drives the committed `dist/index.js` against a real
repository on github.com: it makes each change through the API as a user would, rebuilds the
event payload GitHub delivers for it from the real objects, runs the bundle on that event as
a child process, and asserts on the repository's resulting state. Nothing is mocked, so an
API change or a regression fails the run. The scenario:

1. Writes `OWNERS` (the reviewer as approver and reviewer) and a `.github/prow.yaml` to the
   default branch if they differ, then runs the `label-sync` job.
2. Opens a pull request as the author. The author's `/lgtm` is refused; the reviewer's
   `/assign`, `/approve` and `/lgtm` assign them, apply `approved`, bind `lgtm` to the head
   (`prow/lgtm` status) and merge the pull request on the `/lgtm` comment event.
3. Opens a second pull request; `/hold`, `/approve` and `/lgtm` leave it open. The hold label
   is then removed by hand with no event run, and the `lgtm` cron job (`schedule`) merges it.

Every pull request and branch the run creates is closed and deleted when it ends, pass or
fail. The configuration is read with `config: <sandbox>:.github/prow.yaml`, so the sandbox
owner's organization-wide prow configuration never applies.

Setup, once, by a maintainer:

- A dedicated, empty sandbox repository with merge commits allowed and no branch protection.
  Do not use it for anything else: the cron step evaluates every open pull request in it.
- Two accounts, since Prow never lets the author `/lgtm` their own pull request, each with a
  fine-grained token scoped to the sandbox alone:
  - `E2E_REVIEWER_TOKEN` (secret): a collaborator with write access; contents, issues, pull
    requests and commit statuses read and write. It posts the reviewer's comments and is the
    action's `github-token`.
  - `E2E_AUTHOR_TOKEN` (secret): contents and pull requests read and write. It opens the pull
    requests and posts the author's `/lgtm`.
- `E2E_REPOSITORY` (repository variable): the sandbox as `owner/repo`.

Locally, with the same three variables exported and `dist/` packed: `npm run e2e`.
