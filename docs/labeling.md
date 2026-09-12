# Labeling

Label commands read the `labels` sections of the prow configuration. The configuration
lives in the repository (`.github/prow.yaml` or the legacy `.prowlabels.yaml`), in your
organization's `.project` or `.github` repository, or at an explicit `config` source;
see [configuration](./configuration.md) for locations, precedence and the full schema.
All of the following examples can be placed simultaneously in one file.

The examples below use the legacy flat form, where every top level key is a label
section. In a `prow.yaml` with other sections the same keys sit under `labels:`; the
`/label` allowlist is then `labels: { labels: [...] }`.

## Labels must exist in the repository

Like Prow's `label` plugin, a command only applies labels the repository already
defines; GitHub is never left to create one with a default color. Names are compared
case-insensitively. When any requested label is missing the run fails without adding
anything:

```text
the label(s) kind/cleanup, area/api cannot be applied because the repository doesn't have them. Run the label-sync job or create them.
```

Run the [`label-sync` job](./cron-jobs.md#label-sync) to create every label the
configuration describes, or create them by hand. `/remove-` forms are not gated.
The repository's labels are read once per run.

## Any key is a command

Every label section can be used as a `/<key>` command once it is
listed in `prow-commands`, so a repository needs no code changes to add its own label
families. `/<key> value` adds the label `<key>/value` and `/remove-<key> value` removes it.
Only values listed under the key are accepted; anything else is ignored and, when nothing
is left, the run fails with `<key>: command args missing from body`. Values are matched
case-insensitively and applied with the casing written in the yaml, so `/kind Bug` adds
`kind/bug`. Labels already on the issue are compared the same way when deciding what an
exclusive command replaces or a `/remove-` form deletes.

A key may be written as a plain list of values, or as a mapping with `values` and an
optional `exclusive` flag:

```yaml
# plain list: labels stack
area:
  - bug
  - important

# mapping: a later /triage replaces any existing triage/* label
triage:
  values:
    - accepted
    - needs-information
  exclusive: true
```

With `prow-commands: /area /triage`, the commands `/area bug` and
`/triage accepted` label the issue or PR with `area/bug` and `triage/accepted`.
Because `triage` is `exclusive`, `/triage needs-information` on that issue removes
`triage/accepted` before adding `triage/needs-information`. Exclusivity applies to
labels already on the issue, not to the current comment: every requested value is
kept, so `/priority low high` adds both `priority/low` and `priority/high`.

A key name must be lower case and consist of letters, digits and dashes
(`^[a-z][a-z0-9-]*$`) to be usable as a command. Listing a `/<key>` in `prow-commands`
whose section is missing from the yaml fails the run with
`could not get labels from yaml: Error: <key>: yaml malformed, expected '<key>' top level key`.
A section that is neither a list of values nor a `{ values: [...], exclusive: bool }`
mapping fails the run with
`could not get labels from yaml: Error: <key>: yaml malformed, expected a list of values or { values: [...], exclusive: bool }`.

## Priority labels

```yaml
priority:
  - low
  - high
```

With the command `/priority low`,
the issue or PR will be labeled with `priority/low`.
`/priority` is exclusive by default: a later `/priority` command replaces any existing
`priority/*` labels instead of stacking them. Write the section in mapping form with
`exclusive: false` to let priorities stack.

## Plain labels

```yaml
labels:
  - documentation
  - question
```

With the command `/label documentation`,
the issue or PR will be labeled with `documentation` as written, with no prefix.
Values are split on spaces, so label names containing spaces cannot be listed here.
`lgtm`, `hold`, `approved` and `do-not-merge/*` are always refused by `/label` and
`/remove-label`, even when listed here; use `/lgtm`, `/hold` and `/approve` instead.

## Lifecycle, stage and status labels

`/lifecycle`, `/stage` and `/status` ship with Prow's values and need no
configured section:

Command | Built-in values
--- | ---
`/lifecycle` | `frozen`, `stale`, `rotten`
`/stage` | `alpha`, `beta`, `stable`
`/status` | `approved-for-milestone`, `in-progress`, `in-review`

All three are exclusive, so `/lifecycle stale` removes an existing `lifecycle/rotten`.
A `lifecycle`, `stage` or `status` key in the yaml replaces the built-in values, for
the commands and for the [`label-sync` job](./cron-jobs.md#label-sync) alike;
the mapping form can also set `exclusive: false`:

```yaml
lifecycle:
  - frozen

status:
  values: [triage, in-progress, done]
  exclusive: true
```

A configuration file must still exist in some tier, as it must for every other label command.

## Help wanted and good first issue

`/help` and `/good-first-issue` mirror Prow's help plugin and use GitHub's default
label names, which contain spaces and therefore cannot be listed in a label section.
They are fixed and do not read the configuration at all. Removal
matches labels case-insensitively and deletes them with the casing on the issue:

Command | Adds | `/remove-` form removes
--- | --- | ---
`/help` | `help wanted` | `help wanted`, `good first issue`
`/good-first-issue` | `good first issue`, `help wanted` | `good first issue`

Removal matches label names case-insensitively, like the prefixed label
commands: `/remove-help` removes a label spelled `Help Wanted` as it appears on the issue.

## Removing labels

Every label command has a `/remove-` form that takes the same values and only
removes values listed in the configuration. See
[commands](./commands.md) for the full list and policy.

## Automatic PR labels

To automatically label PRs based on file globs, it's recommended to use the
[GitHub `actions/labeler`](https://github.com/actions/labeler/blob/main/README.md) workflow.
The [Digital Ocean Glob Tool](https://www.digitalocean.com/community/tools/glob)
can be helpful when specifying and building file globs.
