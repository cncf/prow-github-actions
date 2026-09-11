# Prow github actions commands

A command must start a line of the comment (leading whitespace is allowed); a command mentioned mid-sentence is ignored. Commands inside Markdown code (fenced ``` / ~~~ blocks, indented code, inline `code`) and blockquotes are ignored. Commands, their keywords and label values are case-insensitive (`/LGTM cancel` and `/kind Bug` work; the label is applied with the casing from `.prowlabels.yaml`), while milestone titles are matched exactly. Prow-style aliases such as `/remove-lgtm` and `/unhold` are enabled together with their base command. Listing an alias in `prow-commands` enables the whole command family: configuring only `/remove-kind` also enables `/kind`, and only `/unhold` also enables `/hold`. Any other lower-case `/<key>` listed in `prow-commands` is a [label command](./labeling.md#any-key-is-a-command) backed by the `<key>` section of `.prowlabels.yaml`. When a command appears on several lines of one comment every line is applied (`/kind bug` and `/kind cleanup` add both labels), except `/milestone` and `/retitle` where the last line wins; a `cancel` on any line wins over a plain `/lgtm`, `/hold` or `/approve`.

Commands | Policy | Description
--- | --- | ---
`/approve` | [OWNERS](#owners) approver for **every** changed file if the repo has OWNERS files, otherwise Org members & Collaborators | approve all the files for the current PR
`/approve no-issue` | same as `/approve` | same as `/approve`; accepted for Prow compatibility
`/approve cancel` | same as `/approve` | removes your approval on this pull-request
`/remove-approve` | same as `/approve` | same as `/approve cancel`
`/assign [@userA @userB @etc]` | anyone | Assign other users (or yourself if no one is specified). Target user must be Org Member, Collaborator, or have previously commented
`/unassign [@userA @userB @etc]` | anyone | Unassigns specified people (or yourself if no one is specified). Target must have been already assigned.
`/cc [@userA @userB @etc]` | anyone | Request review from specified people (or yourself if no one is specified). Target be an Org Member, Collaborator, or have previously commented.
`/uncc [@userA @userB @etc]` | anyone | Dismiss review request for specified people (or yourself if no one is specified). Target must already have had a review requested.
`/close` | Collaborators **or the issue/PR author** | closes the issue / PR
`/close not-planned` | Collaborators **or the issue/PR author** | closes the issue / PR with the `not planned` state reason
`/reopen` | Collaborators **or the issue/PR author** | reopens a closed issue / PR
`/lock [resolved / off-topic / too-heated / spam]` | Collaborators | locks the issue / PR with the specified reason
`/milestone milestone-name` | Collaborators | Adds issue / PR to an existing milestone. An unknown title fails the run with the list of available milestones
`/milestone clear` | Collaborators | Removes the issue / PR from its milestone
`/retitle some new title` | Collaborators | Renames the issue / PR
`/meow` | anyone | replies with a random cat image from [the cat API](https://thecatapi.com)

Label Commands | Policy | Description
--- | --- | ---
`/area [label1 label2 ...]` | anyone | adds an area/<> label(s) if it's defined in [the `.prowlabels.yaml` file](./labeling.md)
`/remove-area [label1 label2 ...]` | anyone | removes an area/<> label(s) if it's defined in [the `.prowlabels.yaml` file](./labeling.md)
`/kind [label1 label2 ...]` | anyone | adds a kind/<> label(s) if it's defined in [the `.prowlabels.yaml` file](./labeling.md)
`/remove-kind [label1 label2 ...]` | anyone | removes a kind/<> label(s) if it's defined in [the `.prowlabels.yaml` file](./labeling.md)
`/lgtm` | [OWNERS](#owners) reviewer or approver for **at least one** changed file if the repo has OWNERS files, otherwise Collaborators and Org Members; **not the PR author** | adds the `lgtm` label. This is used for [automatic PR merging](./automatic-merging.md). Like Prow, you cannot LGTM your own PR; the guard also applies to issues since the label has no meaning there either
`/lgtm cancel` | same as `/lgtm`, **or the PR author** | removes the `lgtm` label
`/remove-lgtm` | same as `/lgtm`, **or the PR author** | same as `/lgtm cancel`
`/hold` | anyone | adds the `hold` label which prevents [automatic PR merging](./automatic-merging.md). Also see [lgtm removal on pr update](./pr-jobs.md)
`/hold cancel` | anyone | removes the `hold` label
`/unhold`, `/remove-hold` | anyone | same as `/hold cancel`
`/priority [label1 label2 ...]` | anyone | adds a priority/<> label(s) if it's defined in [the `.prowlabels.yaml` file](./labeling.md). Exclusive by default: replaces any existing `priority/*` labels
`/remove-priority [label1 label2 ...]` | anyone | removes a priority/<> label(s) if it's defined in [the `.prowlabels.yaml` file](./labeling.md)
`/label [label1 label2 ...]` | anyone | adds the label(s) verbatim if listed under `labels:` in [the `.prowlabels.yaml` file](./labeling.md). Label names containing spaces are not supported
`/remove-label [label1 label2 ...]` | anyone | removes the label(s) if listed under `labels:` in [the `.prowlabels.yaml` file](./labeling.md)
`/lifecycle [frozen / stale / rotten]` | anyone | adds the `lifecycle/<>` label and removes any other `lifecycle/*`. Values come from Prow and can be [overridden in `.prowlabels.yaml`](./labeling.md#lifecycle-stage-and-status-labels)
`/remove-lifecycle [frozen / stale / rotten]` | anyone | removes the `lifecycle/<>` label
`/stage [alpha / beta / stable]` | anyone | adds the `stage/<>` label and removes any other `stage/*`. Values come from Prow and can be [overridden in `.prowlabels.yaml`](./labeling.md#lifecycle-stage-and-status-labels)
`/remove-stage [alpha / beta / stable]` | anyone | removes the `stage/<>` label
`/status [approved-for-milestone / in-progress / in-review]` | anyone | adds the `status/<>` label and removes any other `status/*`. Values come from Prow and can be [overridden in `.prowlabels.yaml`](./labeling.md#lifecycle-stage-and-status-labels)
`/remove-status [approved-for-milestone / in-progress / in-review]` | anyone | removes the `status/<>` label
`/help` | anyone | adds the `help wanted` label
`/remove-help` | anyone | removes the `help wanted` and `good first issue` labels
`/good-first-issue` | anyone | adds the `good first issue` and `help wanted` labels
`/remove-good-first-issue` | anyone | removes the `good first issue` label
`/<key> [value1 value2 ...]` | anyone | adds `<key>/<value>` label(s) for any other top level `<key>` of [the `.prowlabels.yaml` file](./labeling.md) once `/<key>` is listed in `prow-commands`. Exclusive when the section sets `exclusive: true`
`/remove-<key> [value1 value2 ...]` | anyone | removes `<key>/<value>` label(s) listed under `<key>` in [the `.prowlabels.yaml` file](./labeling.md)
`/remove [label1 label2 ...]` | Collaborators | removes a specified label(s) on an issue / PR

The `/remove-<key>` commands are enabled together with their base command and only remove values listed in `.prowlabels.yaml`, so anyone may use them without being able to strip `lgtm`, `hold` or `approved`. Use `/remove` for arbitrary labels.

## Enabling `/meow`

`/meow` is opt in and calls a third party image provider ([the cat API](https://thecatapi.com)). Anyone who can comment on the repository can invoke it and consume the configured API quota, so enable it only on repositories where that is acceptable. The command must be on its own line. It is best effort: if the provider is unavailable it leaves a short note instead of failing the workflow. Only images served from the provider's own CDN are rendered.

```yaml
permissions:
  issues: write
  pull-requests: write

jobs:
  prow:
    runs-on: ubuntu-latest
    steps:
      - uses: cncf/prow-github-actions@v2
        with:
          prow-commands: /meow
          github-token: '${{ secrets.GITHUB_TOKEN }}'
          cat-api-key: '${{ secrets.CAT_API_KEY }}'
```

The workflow token needs `issues: write` or `pull-requests: write` to post the response, because a new repository's `GITHUB_TOKEN` often defaults to read only. Grant both when the same workflow handles comments on issues and pull requests.

The API key is optional; unauthenticated access is best effort and may be rate limited by the provider. When set, it is provided from a repository secret and registered for runner masking before use, and is never intentionally included in the request URL or a GitHub comment.

## OWNERS

A simplified version of [Prow's OWNERS](https://go.k8s.io/owners) files is supported. When the repository contains any `OWNERS` file, the `/lgtm` and `/approve` commands are authorized against them; when it contains none, org members and collaborators may use both commands. See an [example][owners-example] using OWNERS files.

### Where OWNERS files live

An `OWNERS` file may be placed in any directory. It applies to the files in that directory and all directories below it. Which files apply to a given path is resolved the way Prow does it: walk from the file's directory up to the repository root and take the union of every `OWNERS` file on the way (a directory's `OWNERS` plus its parents'). A root-only `OWNERS` therefore covers the whole repository.

Setting `options.no_parent_owners: true` in an `OWNERS` file stops the walk there, so only that file (and any below it) applies and the parents' approvers and reviewers are not inherited.

### Which files decide the outcome

On a pull request the changed files are listed (for renames both the old and the new path count) and their OWNERS are read from the PR's **base** branch. The head branch is never consulted, so a pull request cannot grant itself approvers by editing an `OWNERS` file.

- `/approve`: the commenter must be an `approver` for **every** changed file. The refusal names the first file that is not covered and the OWNERS files consulted for it.
- `/lgtm`: the commenter must be a `reviewer` or `approver` for **at least one** changed file (Prow's lgtm rule).
- On an issue there are no changed files, so the root `OWNERS` of the default branch is used as before.

The `approvers` role does not grant `/lgtm` on its own for issues; on pull requests an approver of a changed file may also `/lgtm`.

### Failure modes

Authorization fails closed:

- a changed file with no covering `OWNERS` file fails the command with an error naming the file;
- an `OWNERS` file that cannot be fetched or parsed (for example `approvers` is not a list) fails the command;
- the org-member/collaborator fallback applies only when the repository has **no** `OWNERS` file at all.

### File format

The OWNERS file must be in YAML format. All entries are expected to be GitHub usernames (compared case-insensitively); teams are not supported.

Key | Meaning
--- | ---
`approvers` | list of usernames who may use `/approve` (and `/lgtm` on a pull request)
`reviewers` | list of usernames who may use `/lgtm`
`options.no_parent_owners` | `true` stops inheritance from parent directories

`emeritus_approvers`, `emeritus_reviewers`, `labels` and `filters` are accepted but ignored (`filters` is noted in the debug log). `OWNERS_ALIASES` files and aliases are not supported. Unknown keys are tolerated.

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

# Optional: do not inherit approvers and reviewers from parent directories
options:
  no_parent_owners: false
```

[owners-example]: ./examples.md#review-and-approve-pull-requests
