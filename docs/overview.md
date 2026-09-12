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
that can be run with specific [Github "events"](https://docs.github.com/en/actions/reference/events-that-trigger-workflows)

## Read more
- [Prow github actions available commands](./commands.md)
- [Labeling issues](./labeling.md)
- [Automatically Labeling PRs](./examples.md#pr-labeler) (via `actions/labeler` with `pull_request_target`)
- [Automatic PR merging](./automatic-merging.md)
  - [Available jobs: lgtm merger, label-sync](./cron-jobs.md)
- [Jobs to run on PR update](./pr-jobs.md)
- [Examples](./examples.md)
- [Releasing](./releasing.md)
- [Contributing](./contributing.md)
