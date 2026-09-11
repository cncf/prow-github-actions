# Prow github actions commands

A command must start a line of the comment (leading whitespace is allowed); a command mentioned mid-sentence is ignored. Commands and their keywords are case-insensitive (`/LGTM cancel` works); label values are matched by the label configuration, and milestone titles are matched exactly. Prow-style aliases such as `/remove-lgtm` and `/unhold` are enabled together with their base command. Listing an alias in `prow-commands` enables the whole command family: configuring only `/remove-kind` also enables `/kind`, and only `/unhold` also enables `/hold`. Any other lower-case `/<key>` listed in `prow-commands` is a [label command](./labeling.md#any-key-is-a-command) backed by the `<key>` section of `.prowlabels.yaml`. When a command appears on several lines of one comment every line is applied (`/kind bug` and `/kind cleanup` add both labels), except `/milestone` and `/retitle` where the last line wins; a `cancel` on any line wins over a plain `/lgtm`, `/hold` or `/approve`.

Commands | Policy | Description
--- | --- | ---
`/approve` | [OWNERS](#owners) if present, otherwise Org members & Collaborators | approve all the files for the current PR
`/approve no-issue` | [OWNERS](#owners) if present, otherwise Org members & Collaborators | same as `/approve`; accepted for Prow compatibility
`/approve cancel` | [OWNERS](#owners) if present, otherwise Org member & Collaborators | removes your approval on this pull-request
`/remove-approve` | [OWNERS](#owners) if present, otherwise Org member & Collaborators | same as `/approve cancel`
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
`/lgtm` | [OWNERS](#owners) reviewers if present, otherwise Collaborators and Org Members; **not the PR author** | adds the `lgtm` label. This is used for [automatic PR merging](./automatic-merging.md). Like Prow, you cannot LGTM your own PR; the guard also applies to issues since the label has no meaning there either
`/lgtm cancel` | [OWNERS](#owners) reviewers if present, otherwise Collaborators and Org Members, **or the PR author** | removes the `lgtm` label
`/remove-lgtm` | [OWNERS](#owners) reviewers if present, otherwise Collaborators and Org Members, **or the PR author** | same as `/lgtm cancel`
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

A simplified version of [Prow's OWNERS](https://go.k8s.io/owners) file is supported. When an OWNERS file is present at the root of the repository, it is used to authorize the /lgtm and /approve commands. See an [example][owners-example] using an OWNERS file.

The `reviewers` role grants access to the /lgtm command and the approvers role grants access to the /approve command.

The `approvers` role does not grant the reviewers role, a user must be in both roles to use /lgtm and /approve.

The OWNERS file must be in YAML format. All entries are expected to be GitHub usernames; teams are not supported.

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

[owners-example]: ./examples.md#review-and-approve-pull-requests
