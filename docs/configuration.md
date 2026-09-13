# Configuration

Prow github actions reads one YAML document, `prow.yaml`, from up to two places and
layers them: an organization-wide file, then the repository's own file. A repository
with only the legacy `.prowlabels.yaml` needs no changes.

## Where configuration lives

Tiers, lowest precedence first. Later tiers override earlier ones.

Tier | Location | Notes
--- | --- | ---
Built-in | `/lifecycle`, `/stage`, `/status` defaults | see [labeling](./labeling.md#lifecycle-stage-and-status-labels)
Organization | `<owner>/.project` repo, `prow.yaml`; then `<owner>/.github` repo, `prow.yaml` | first found wins; a missing repo or file is skipped
Explicit source | the `config` input | **replaces** the organization tier when set; must exist
Repository | the event repository, default branch: `.github/prow.yaml`, `.github/prowlabels.yaml`, `prow.yaml`, `.prowlabels.yaml`, then the `.yml` spelling of each, in that order | first found wins

A 404 on an organization or repository probe is silent. Any other error (permissions,
rate limit, 5xx) fails the run. Label commands require a file in at least one tier;
otherwise the run fails with
`no prow configuration found: looked for prow.yaml in <owner>/.project and <owner>/.github, and .github/prow.yaml, .github/prowlabels.yaml, prow.yaml, .prowlabels.yaml (.yaml/.yml) in <owner>/<repo>`.

The configuration is read once per run, however many commands the comment carries.

### The `config` input

```yaml
- uses: cncf/prow-github-actions@v2
  with:
    config: cncf/prow-config:configs/prow.yaml@v1
    github-token: ${{ secrets.GITHUB_TOKEN }}
```

Form | Read with | Notes
--- | --- | ---
`owner/repo:path[@ref]` | `github-token` | `ref` is a branch, tag or SHA; defaults to the default branch
`https://…` | anonymous `fetch`, 5 s timeout | must answer 2xx; `http://` is refused

When `config` is set the `<owner>/.project` and `<owner>/.github` repositories are not
consulted. The repository tier still applies on top. A 404 or non-2xx answer fails the run:
an explicit source must exist.

A private cross-repository source is readable only when `github-token` can read it. The
default `GITHUB_TOKEN` is scoped to the event repository, so use a token (or GitHub App
installation token) with read access to the configuration repository. There is no
separate token input.

## `prow.yaml`

```yaml
labels:
  # plain list: labels stack
  area:
    - api
    - docs

  # values may carry the GitHub label color (6 hex digits) and description
  kind:
    - name: bug
      color: d73a4a
      description: Something is not working
    - name: cleanup
      color: c5def5
    - feature

  # mapping: a later /priority replaces any existing priority/* label
  priority:
    values: [low, high]
    exclusive: true

  # the /label allowlist, applied verbatim without a prefix
  labels:
    - documentation
    - question

# needs-* labels: see the require_matching_label section below
require_matching_label:
  - regexp: ^kind/
    missing_label: needs-kind
    issues: true
    prs: true
    missing_comment: Please add a kind label with /kind.
  - regexp: ^area/
    missing_label: needs-area
    prs: true
    grace_period_duration: 5s

# the merge gate of the lgtm job; these are the defaults
tide:
  labels: [lgtm]
  missing_labels: [do-not-merge/*, needs-rebase, hold]
  merge_method: merge

# the label /hold applies; this is the default
hold:
  label: do-not-merge/hold

# reviewers requested from OWNERS files when a pull request opens
blunderbuss:
  request_count: 2
  max_request_count: 4
  exclude_approvers: false
  ignore_drafts: true
  ignore_authors: ['dependabot[bot]']
```

### `labels`

A mapping of label sections. Every key becomes a `/<key>` command once listed in
`prow-commands`; see [labeling](./labeling.md#any-key-is-a-command) for command semantics.

Section form | Meaning
--- | ---
`key: [a, b]` | allowed values; labels stack
`key: { values: [a, b], exclusive: bool }` | `exclusive: true` replaces existing `key/*` labels

Value form | Meaning
--- | ---
`bug` | the label `key/bug`
`{ name: bug, color: d73a4a, description: … }` | the same label with metadata; `color` is six hex digits, no `#`

`color` and `description` are applied by the [`label-sync` job](./cron-jobs.md#label-sync);
label commands themselves only use `name`. Quote a color made only of digits
(`color: '123456'`) so YAML keeps it a string.

The `/label` allowlist is the section named `labels` inside `labels`:

```yaml
labels:
  labels:
    - documentation
```

### The label catalogue

The [`label-sync` job](./cron-jobs.md#label-sync) creates and updates the union of:

Source | Labels | Color, description
--- | --- | ---
every `labels.<key>` section | `<key>/<value>`; the `/label` allowlist `labels.labels` verbatim | from the value's `color` and `description`
built-in `/lifecycle`, `/stage`, `/status` values | `lifecycle/frozen`, `lifecycle/stale`, `lifecycle/rotten`, `stage/alpha`, `stage/beta`, `stage/stable`, `status/approved-for-milestone`, `status/in-progress`, `status/in-review` | only when the configuration has no section of that key
the action's own commands | `lgtm`, `approved`, `hold.label` (`do-not-merge/hold`) and the legacy `hold`, `help wanted`, `good first issue` | built-in
`require_matching_label` | every `missing_label` | `ededed` for `needs-*`

Precedence per label: the configuration's `color`/`description`, then the built-in
default, otherwise none (GitHub picks a color; no description is written). Built-in
colors follow [kubernetes/test-infra `label_sync`](https://github.com/kubernetes/test-infra/blob/master/label_sync/labels.yaml)
where the label exists there:

Label | Color
--- | ---
`lgtm` | `15dd18`
`approved` | `0ffa16`
`hold`, `do-not-merge/hold` | `e11d21`
`help wanted` | `006b75`
`good first issue` | `7057ff`
`lifecycle/frozen` | `d3e2f0`
`lifecycle/stale` | `795548`
`lifecycle/rotten` | `604460`
`needs-*` | `ededed`

Labels declared under `labels:` in [OWNERS files](./commands.md#owners) are **not** part of
the catalogue: the job has no pull request to scope a tree walk to. List them in a
`labels` section (or the `/label` allowlist) as well, or create them by hand;
[`owners-label`](./labeling.md#labels-from-owners-files) skips a label the repository lacks.

Names are unique case-insensitively (the first definition wins) and the job never
deletes or renames a label. Label commands refuse labels the repository does not have
([labeling](./labeling.md#labels-must-exist-in-the-repository)), so run the job after
changing the configuration:

```yaml
name: Sync labels from prow.yaml
on:
  workflow_dispatch:
  push:
    branches: [main]
    paths: [.github/prow.yaml]

permissions:
  contents: read
  issues: write

jobs:
  execute:
    runs-on: ubuntu-latest
    steps:
      - uses: cncf/prow-github-actions@v2
        with:
          jobs: label-sync
          github-token: '${{ secrets.GITHUB_TOKEN }}'
```

### `require_matching_label`

A list of rules modelled on Prow's [`require-matching-label`](https://github.com/kubernetes-sigs/prow/tree/main/pkg/plugins/require-matching-label)
plugin: an issue or pull request with no label matching `regexp` gets `missing_label`;
once a matching label arrives `missing_label` is removed again. Each `missing_label` is
part of the [label catalogue](#the-label-catalogue), so the
[`label-sync` job](./cron-jobs.md#label-sync) creates it; a `missing_label` the repository
does not have fails the run like any other label
([labeling](./labeling.md#labels-must-exist-in-the-repository)).

Field | Required | Meaning
--- | --- | ---
`regexp` | yes | a JavaScript regular expression matched, case-sensitively, against every label on the object
`missing_label` | yes | the label added when nothing matches; compared case-insensitively
`issues`, `prs` | no | which objects the rule applies to; when neither is set both are `true`, when one is set the other is `false`
`missing_comment` | no | comment posted together with `missing_label`; deleted again when the label is removed
`grace_period_duration` | no | how long `opened`/`reopened` wait before evaluating, ex: `5s`, `2m`, `500ms`; default `0`, capped at `30s`

Event | Evaluates
--- | ---
`issues` / `pull_request` `opened`, `reopened` | every applicable rule, after the longest `grace_period_duration` among them (so other labelers act first); labels are re-read after the wait
`issues` / `pull_request` `labeled`, `unlabeled` | the rules whose `regexp` matches the changed label, **or whose `missing_label` is the changed label**
`issue_comment` [`/check-required-labels`](./commands.md) | every applicable rule, no grace period

Labels on the object | Action
--- | ---
no `regexp` match, no `missing_label` | add `missing_label`; post `missing_comment` if set and not already posted
a `regexp` match and `missing_label` | remove `missing_label`; delete the bot's earlier `missing_comment`
otherwise | nothing

The comment ends with an invisible marker,
`<!-- prow-github-actions/require-matching-label: <missing_label> -->`, which is how a later
run finds the bot's own comment to delete it and avoids posting it twice. Only comments by a
bot account (`github-actions[bot]` or any `Bot` user) are deleted.

A `grace_period_duration` in Go's syntax (`1m30s`) is accepted; anything else fails the run.
Longer than `30s` is clamped because the wait burns Actions minutes.

Divergences from Prow:

- a `labeled`/`unlabeled` event on the `missing_label` itself re-evaluates the rule, so a
  `needs-kind` removed by hand while no `kind/*` label exists is re-added. Prow only reacts to
  labels matching `regexp`. This matches the cncf/automation labeler that repositories are
  migrating from;
- the grace period is capped at `30s`.

The workflow must subscribe to the events; see [events](./events.md#issues-and-pull_request).

### `tide`

The merge gate of the [`lgtm` job](./automatic-merging.md#the-merge-gate), modelled on
Prow's tide query. Every field is optional; a configured list **replaces** the default list
rather than extending it.

Field | Default | Meaning
--- | --- | ---
`labels` | `[lgtm]` | every pattern must match a label on the PR
`missing_labels` | `[do-not-merge/*, needs-rebase, hold]` | no pattern may match a label on the PR
`merge_method` | the `merge-method` input, else `merge` | `merge`, `squash` or `rebase`; wins over the input

Entries are label names compared case-insensitively; `*` matches any run of characters,
`/` included. An empty name or an unknown `merge_method` fails the run.

### `hold`

Field | Default | Meaning
--- | --- | ---
`label` | `do-not-merge/hold` | the label [`/hold`](./commands.md) applies; cancel removes it and the legacy `hold`

The label is in the [label catalogue](#the-label-catalogue) and, like every command label,
must exist in the repository. It is refused by `/label` and `/remove-label`. Set
`label: hold` to keep the pre-`do-not-merge/hold` name; see
[upgrading](./automatic-merging.md#upgrading-from-the-hold-label).

### `blunderbuss`

Modelled on Prow's [`blunderbuss`](https://github.com/kubernetes-sigs/prow/tree/main/pkg/plugins/blunderbuss)
plugin: when a pull request opens, request reviews from the people the
[OWNERS files](./commands.md#owners) of the base branch name for its changed files. The
section is optional; with no OWNERS files in the repository the plugin is a no-op.

Field | Default | Meaning
--- | --- | ---
`request_count` | `2` | reviewers to request; integer ≥ 1
`max_request_count` | unset | never leave the pull request with more requested reviewers than this in total; ≥ `request_count`
`exclude_approvers` | `false` | only `reviewers` are candidates, not `approvers`
`ignore_drafts` | `true` | a draft waits for `ready_for_review`; `false` requests on `opened` and skips `ready_for_review`
`ignore_authors` | `[]` | pull requests by these authors get no automatic request (case-insensitive)

Event | Action
--- | ---
`pull_request` `opened` | request `request_count` reviewers, unless the PR is a draft and `ignore_drafts` is on, or the author is in `ignore_authors`
`pull_request` `ready_for_review` | the same, only while `ignore_drafts` is on
`issue_comment` [`/auto-cc`](./commands.md) | the same, on any open pull request, ignoring `ignore_drafts` and `ignore_authors`

Candidates are the union of `reviewers` (plus `approvers` unless `exclude_approvers`) of
every OWNERS file covering a changed file, minus the author, the already requested
reviewers and the assignees. Like Prow, each candidate is weighted by the number of changed
files they cover: the request is filled from the best-covering candidates first and drawn at
random among equals. With `max_request_count`, `request_count` is reduced so that the
already requested reviewers plus the new ones do not exceed it. Nobody left to request is a
debug-logged no-op; a refused request fails the run. No comment is posted.

The workflow token needs `pull-requests: write` and the workflow must subscribe to
`ready_for_review` for drafts; see [events](./events.md#issues-and-pull_request).

### `owners-label`

No configuration. Whenever a pull request is `opened`, `reopened` or `synchronize`d the
`labels:` of the OWNERS files covering its changed files are added; see
[labeling](./labeling.md#labels-from-owners-files). The labels must already exist in the
repository — declare them in a `labels` section for the [`label-sync` job](#the-label-catalogue)
or create them by hand.

Unknown top level keys are ignored and logged once at debug level.

## Legacy `.prowlabels.yaml`

The pre-existing format is a flat map of label sections and is still accepted at every
path, including `prow.yaml`:

```yaml
area:
  - bug

labels:
  - documentation

triage:
  values: [accepted, needs-information]
  exclusive: true
```

Both forms share one parser. The top level `labels` key decides which form a document is:

`labels` is | Form | The `/label` allowlist is
--- | --- | ---
a **list** | legacy: every top level key is a label section | the top level `labels` list
a **mapping** | new: `require_matching_label`, `tide`, `hold`, `blunderbuss` may sit alongside | `labels.labels`
absent, and `require_matching_label`, `tide`, `hold` or `blunderbuss` is present | new | `labels.labels`
absent otherwise | legacy | none

```yaml
# legacy: /label may apply 'documentation'
labels:
  - documentation
kind:
  - bug
```

```yaml
# new: the same allowlist, nested
labels:
  labels:
    - documentation
  kind:
    - bug
```

In a legacy document every key must be a valid label section; anything else fails with
`<key>: yaml malformed, expected a list of values or { values: [...], exclusive: bool }`.

## Merge rules

Organization (or explicit source) first, repository on top.

Key | Rule
--- | ---
`labels` | per section: a repository section replaces the organization section of the same name; other organization sections survive
`require_matching_label` | lists concatenate, organization rules first
`tide`, `hold`, `blunderbuss` | shallow merge; a repository field wins

```yaml
# <owner>/.project prow.yaml
labels:
  kind: [bug, cleanup]
  area: [api]
```

```yaml
# <repo> .github/prow.yaml
labels:
  kind: [docs]
```

The repository sees `kind: [docs]` and `area: [api]`.
