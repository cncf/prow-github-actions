# Overview

Prow github actions is an interface for Github actions
to behave much like the kubernetes Prow bot.
Prow is a CI/CD system that provides GitHub automation in the form of policy enforcement,
chat-ops via `/foo` style commands, and automatic PR merging.
This powerful system can be used for both large and small open source projects
to enable better project management and collaborator workflows.
This is achieved through utilizing Github actions CI/CD system
and removes much of the overhead and infrastructure needed for running the Prow bot.

Workflows are broken down into commands and jobs
that can be run with specific [Github "events"](https://docs.github.com/en/actions/reference/events-that-trigger-workflows);
[events](./events.md) lists which ones the action routes.

One caller workflow installs everything through the reusable workflow; see
[installing](./installing.md).

## Runtime adapters

The handlers under `src/` reach the runtime they run on only through the `Platform`
interface in [`src/platform/types.ts`](../src/platform/types.ts): the event
(`Context`: event name, payload, repository), the seven inputs `action.yml` declares,
a logger, the API base url and `fail()`. The entry point installs an implementation with
`setPlatform()` before dispatching; today the only one is
[`src/adapters/actions.ts`](../src/adapters/actions.ts), backed by `@actions/core`,
`@actions/github` and the runner's `GITHUB_*` environment.

Everything a handler memoizes for an event — configuration, repository labels, OWNERS
trees, warnings already shown — lives in the platform's `RunState`, created once per
event by the adapter, so nothing carries over between events or repositories in a
long-lived process.

Handlers therefore import from `../platform`, never from `@actions/*` or `node:*`;
ESLint rejects such imports outside `src/adapters/` and `src/main.ts`, and
`tsconfig.core.json` type-checks the handlers with no Node types at all. This keeps the
door open to a second adapter, such as a GitHub App receiving webhooks, without touching
the handlers.

## Read more
- [Prow for your organization: the guided path](./prow-for-your-org.md)
- [Installing: one repository, an organization, upgrading](./installing.md)
- [Events the action routes](./events.md)
- [Prow github actions available commands](./commands.md)
- [Labeling issues](./labeling.md)
- [Automatically Labeling PRs](./examples.md#pr-labeler) (via `actions/labeler` with `pull_request_target`)
- [Automatic PR merging](./automatic-merging.md)
  - [Available jobs: lgtm merger, label-sync](./cron-jobs.md)
- [Jobs to run on PR update](./pr-jobs.md)
- [Examples](./examples.md)
- [Releasing](./releasing.md)
- [Contributing](./contributing.md)
