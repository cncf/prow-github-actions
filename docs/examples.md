# Examples

* [`.prowlabels.yaml`](#prowlabelsyaml)
* [Review and approve pull requests](#review-and-approve-pull-requests)
* [All prow github actions](#all-prow-github-actions)
* [A dynamic label command](#a-dynamic-label-command)
* [`/meow`](#meow)
* [PR Labeler](#pr-labeler)
* [Automatic PR merger](#automatic-pr-merger)
* [PR job to remove lgtm label on update](#pr-job-to-remove-lgtm-label-on-update)

## `.prowlabels.yaml`

A `.prowlabels.yaml` file is necessary for most of the labeling commands & jobs:

```yaml
area:
  - bug
  - important

kind:
  - failing-test
  - cleanup

priority:
  - low
  - mid
  - high

# plain labels applied verbatim by /label
labels:
  - documentation
  - question

# mapping form: a later /triage replaces any existing triage/* label
triage:
  values:
    - accepted
    - needs-information
  exclusive: true
```

## Review and approve pull requests

Below is an example of how to use [OWNERS](./commands.md#owners) files with the Prow action.

Add an OWNERS file to the root of the repository in the default branch.
```yaml
# List of usernames who may use /lgtm
reviewers:
  - user1
  - user2
  - user3

# List of usernames who may use /approve
approvers:
  - user1
  - user2
  - admin1
```

Optionally add more OWNERS files in subdirectories, for example `sdk/OWNERS`. Their approvers and reviewers apply to files under `sdk/` in addition to the root ones, unless `no_parent_owners` is set.

```yaml
# sdk/OWNERS: sdk-maintainer may /approve and /lgtm changes under sdk/
approvers:
  - sdk-maintainer
reviewers:
  - sdk-reviewer
```

A pull request that changes files under `sdk/` and elsewhere needs an approver for every changed file (`user1` or `admin1` here, since they are inherited from the root), while `/lgtm` needs a reviewer or approver of at least one changed file. OWNERS files are read from the base branch of the pull request.

Grant the default GITHUB_TOKEN permission to label issues and review pull requests.
```yaml
name: Handle prow slash commands
on:
  issue_comment:
    types: [created]

# Grant additional permissions to the GITHUB_TOKEN
permissions:
  # Allow labeling issues
  issues: write
  # Allow adding a review to a pull request
  pull-requests: write
  # Allow reading the repository
  contents: read

jobs:
  execute:
    runs-on: ubuntu-latest
    steps:
      - uses: cncf/prow-github-actions@v2
        with:
          prow-commands: /approve /lgtm
          github-token: '${{ secrets.GITHUB_TOKEN }}'
```

## All prow github actions

The full list of available commands is kept in the [README quickstart](../README.md#quickstart). Aliases (`/unhold`, `/remove-kind`, ...) come with their base command. One short example:

```yaml
name: Prow github actions
on:
  issue_comment:
    types: [created]

permissions:
  issues: write
  pull-requests: write
  contents: read

jobs:
  execute:
    runs-on: ubuntu-latest
    steps:
      - uses: cncf/prow-github-actions@v2
        with:
          prow-commands: /assign /approve /retitle /area /kind /priority /lgtm /close /reopen /hold /cc /uncc
          github-token: '${{ secrets.GITHUB_TOKEN }}'
```

## A dynamic label command

Any top level key of `.prowlabels.yaml` becomes a `/<key>` command once listed in `prow-commands`:

```yaml
name: Triage commands
on:
  issue_comment:
    types: [created]

permissions:
  issues: write
  pull-requests: write
  contents: read

jobs:
  execute:
    runs-on: ubuntu-latest
    steps:
      - uses: cncf/prow-github-actions@v2
        with:
          prow-commands: /triage
          github-token: '${{ secrets.GITHUB_TOKEN }}'
```

With the `triage` section of the [`.prowlabels.yaml`](#prowlabelsyaml) above, `/triage accepted` labels the issue or PR with `triage/accepted`.

## `/meow`

`/meow` replies with a random cat image. It is opt in and calls a third party provider; see [Enabling `/meow`](./commands.md#enabling-meow).

```yaml
name: Meow
on:
  issue_comment:
    types: [created]

permissions:
  issues: write
  pull-requests: write

jobs:
  execute:
    runs-on: ubuntu-latest
    steps:
      - uses: cncf/prow-github-actions@v2
        with:
          prow-commands: /meow
          github-token: '${{ secrets.GITHUB_TOKEN }}'

          # this is optional; provide it from a repository secret
          cat-api-key: '${{ secrets.CAT_API_KEY }}'
```

## PR Labeler
Use the Github actions/labeler which now supports `pull_request_target`
```yaml
name: Pull Request Labeler
on:
  - pull_request_target

permissions:
  contents: read
  pull-requests: write

jobs:
  triage:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/labeler@main
        with:
          repo-token: '${{ secrets.GITHUB_TOKEN }}'
```

## Automatic PR merger
See [automatic PR merging](./automatic-merging.md) for the full workflow.

## PR job to remove lgtm label on update
See [PR jobs](./pr-jobs.md) for the full workflow.
