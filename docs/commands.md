# Prow github actions commands

Commands | Policy | Description
--- | --- | ---
`/approve` | [OWNERS](#owners) if present, otherwise Org members & Collaborators | approve all the files for the current PR
`/approve cancel` | [OWNERS](#owners) if present, otherwise Org member & Collaborators | removes your approval on this pull-request
`/assign [@userA @userB @etc]` | anyone | Assign other users (or yourself if no one is specified). Target user must be Org Member, Collaborator, or have previously commented
`/unassign [@userA @userB @etc]` | anyone | Unassigns specified people (or yourself if no one is specified). Target must have been already assigned.
`/cc [@userA @userB @etc]` | anyone | Request review from specified people (or yourself if no one is specified). Target be an Org Member, Collaborator, or have previously commented.
`/uncc [@userA @userB @etc]` | anyone | Dismiss review request for specified people (or yourself if no one is specified). Target must already have had a review requested.
`/close` | Collaborators | closes the issue / PR
`/reopen` | Collaborators | reopens a closed issue / PR
`/lock [resolved / off-topic / too-heated / spam]` | Collaborators | locks the issue / PR with the specified reason
`/milestone milestone-name` | Collaborators | Adds issue / PR to an existing milestone
`/retitle some new title` | Collaborators | Renames the issue / PR
`/meow` | anyone | replies with a random cat image from [the cat API](https://thecatapi.com)

Label Commands | Policy | Description
--- | --- | ---
`/area [label1 label2 ...]` | anyone | adds an area/<> label(s) if it's defined in [the `.prowlabels.yaml` file](./labeling.md)
`/kind [label1 label2 ...]` | anyone | adds a kind/<> label(s) if it's defined in [the `.prowlabels.yaml` file](./labeling.md)
`/lgtm` | [OWNERS](#owners) if present, otherwise Collaborators and Org Members | adds the `lgtm` label. This is used for [automatic PR merging]()
`/lgtm cancel` | [OWNERS](#owners) if present, otherwise Collaborators and Org Members | removes the `lgtm` label
`/hold` | anyone | adds the `hold` label which prevents [automatic PR merging](./automatic-merging.md). Also see [lgtm removal on pr update](./pr-jobs.md)
`/hold cancel` | anyone | removes the `hold` label
`/priority [label1 label2 ...]` | anyone | adds a priority/<> label(s) if it's defined in [the `.prowlabels.yaml` file](./automatic-merging.md)
`/remove [label1 label2 ...]` | Collaborators | removes a specified label(s) on an issue / PR

## Enabling `/meow`

`/meow` is opt in and calls a third party image provider ([the cat API](https://thecatapi.com)). Anyone who can comment on the repository can invoke it and consume the configured API quota, and the command must be on its own line. It is best effort: if the provider is unavailable it leaves a short note instead of failing the workflow.

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

The `@v2` ref is a floating tag the maintainers move per release. `/meow` ships in the next `v2.x` release, so this example applies once that release is published and the `v2` tag points at it; until then, pin to the release that includes it.

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
