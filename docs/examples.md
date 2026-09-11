# Examples

* [`.prowlabels.yaml`](#prowlabelsyaml)
* [Review and Approve Pull Requests](#review-and-approve-pull-requests)
* [All prow github actions](#all-prow-github-actions)
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
```

## Review and Approve Pull Requests

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

jobs:
  execute:
    runs-on: ubuntu-latest
    steps:
      - uses: cncf/prow-github-actions@v1
        with:
          prow-commands: |
            /approve
            /lgtm
          github-token: '${{ secrets.GITHUB_TOKEN }}'
```

### All prow github actions

```yaml
name: Prow github actions
on:
  issue_comment:
    types: [created]

jobs:
  execute:
    runs-on: ubuntu-latest
    steps:
      - uses: cncf/prow-github-actions@v1
        with:
          prow-commands: |
            /assign
            /unassign
            /approve
            /retitle
            /area
            /kind
            /priority
            /remove
            /lgtm
            /close
            /reopen
            /lock
            /milestone
            /hold
            /cc
            /uncc
          github-token: '${{ secrets.GITHUB_TOKEN }}'
```

### PR Labeler
Use the Github actions/labeler which now supports `pull_request_target`
```yaml
name: Pull Request Labeler
on:
  - pull_request_target

jobs:
  triage:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/labeler@main
        with:
          repo-token: '${{ secrets.GITHUB_TOKEN }}'
```

### Automatic PR merger
```yaml
name: Merge on lgtm label
on:
  schedule:
    - cron: '0 * * * *'

jobs:
  execute:
    runs-on: ubuntu-latest
    steps:
      - uses: cncf/prow-github-actions@v1
        with:
          jobs: lgtm
          github-token: '${{ secrets.GITHUB_TOKEN }}'
```

### PR job to remove lgtm label on update
```yaml
name: Run Jobs on PR
on: pull_request

jobs:
  execute:
    runs-on: ubuntu-latest
    steps:
      - uses: cncf/prow-github-actions@v1
        with:
          jobs: lgtm
          github-token: '${{ secrets.GITHUB_TOKEN }}'
```
