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

# validated now; enforcement lands in a later release
require_matching_label:
  - regexp: ^kind/
    missing_label: needs-kind
    issues: true
    prs: true
    missing_comment: Please add a kind label with /kind.
  - regexp: ^area/
    missing_label: needs-area
    prs: true
    grace_period_duration: 5m

# validated now; enforcement lands in a later release
tide:
  labels: [lgtm, approved]
  missing_labels: [do-not-merge/hold]
  merge_method: squash

# validated now; enforcement lands in a later release
hold:
  label: do-not-merge/hold
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
the action's own commands | `lgtm`, `approved`, `hold` (and `hold.label` when set), `help wanted`, `good first issue` | built-in
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

A list of rules, each modelled on Prow's plugin of the same name. Parsed and validated;
enforcement lands in a later release. Each `missing_label` is part of the
[label catalogue](#the-label-catalogue).

Field | Required | Meaning
--- | --- | ---
`regexp` | yes | a JavaScript regular expression matched against label names
`missing_label` | yes | the label added when nothing matches
`issues`, `prs` | no | which objects the rule applies to; when neither is set both are `true`
`missing_comment` | no | comment posted with the missing label
`grace_period_duration` | no | how long to wait before acting, ex: `5m`

### `tide`

Parsed and validated; enforcement lands in a later release. Today the lgtm cron job merges
on the `lgtm` label and the `merge-method` input.

Field | Meaning
--- | ---
`labels` | labels a PR must carry to merge
`missing_labels` | labels a PR must not carry to merge
`merge_method` | `merge`, `squash` or `rebase`

### `hold`

Parsed and validated; enforcement lands in a later release. Today `/hold` applies the
`hold` label. A configured `label` is added to the [label catalogue](#the-label-catalogue)
next to `hold`.

Field | Meaning
--- | ---
`label` | the label `/hold` applies

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
a **mapping** | new: `require_matching_label`, `tide`, `hold` may sit alongside | `labels.labels`
absent, and `require_matching_label`, `tide` or `hold` is present | new | `labels.labels`
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
`tide`, `hold` | shallow merge; a repository field wins

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
