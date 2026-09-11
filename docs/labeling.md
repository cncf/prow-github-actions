# Labeling

Prow github actions expects the file `.prowlabels.yaml` to be in the root of the project.
This is needed for most labeling commands and jobs.
All of the following examples can be placed simultaneously in the `.prowlabels.yaml` file.

## Any key is a command

Every top level key of `.prowlabels.yaml` can be used as a `/<key>` command once it is
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
triage:
  - accepted
  - needs-information

# mapping: a later /level replaces any existing level/* label
level:
  values:
    - sandbox
    - incubation
    - graduation
    - archived
  exclusive: true
```

With `prow-commands: /triage /level`, the commands `/triage accepted` and
`/level incubation` label the issue or PR with `triage/accepted` and `level/incubation`.
Because `level` is `exclusive`, `/level graduation` on that issue removes
`level/incubation` before adding `level/graduation`.

A key name must be lower case and consist of letters, digits and dashes
(`^[a-z][a-z0-9-]*$`) to be usable as a command. Listing a `/<key>` in `prow-commands`
whose section is missing from the yaml fails the run with
`<key>: yaml malformed, expected '<key>' top level key`.

## Area labels

```yaml
area:
  - bug
  - important
```

With the command `/area bug`,
the issue or PR will be labeled with `area/bug`

## Kind labels

```yaml
kind:
  - failing-test
  - cleanup
```

With the command `/kind cleanup`,
the issue or PR will be labeled with `kind/cleanup`

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
  - good-first-issue
  - help-wanted
```

With the command `/label good-first-issue`,
the issue or PR will be labeled with `good-first-issue` as written, with no prefix.
Values are split on spaces, so label names containing spaces cannot be listed here.

## Lifecycle, stage and status labels

`/lifecycle`, `/stage` and `/status` ship with Prow's values and need no
`.prowlabels.yaml` section:

Command | Built-in values
--- | ---
`/lifecycle` | `frozen`, `stale`, `rotten`
`/stage` | `alpha`, `beta`, `stable`
`/status` | `approved-for-milestone`, `in-progress`, `in-review`

All three are exclusive, so `/lifecycle stale` removes an existing `lifecycle/rotten`.
A `lifecycle`, `stage` or `status` key in the yaml replaces the built-in values;
the mapping form can also set `exclusive: false`:

```yaml
lifecycle:
  - frozen

status:
  values: [triage, in-progress, done]
  exclusive: true
```

The file itself must still exist, as it does for every other label command.

## Help wanted and good first issue

`/help` and `/good-first-issue` mirror Prow's help plugin and use GitHub's default
label names, which contain spaces and therefore cannot be listed in
`.prowlabels.yaml`. They are fixed and do not read the file at all:

Command | Adds | `/remove-` form removes
--- | --- | ---
`/help` | `help wanted` | `help wanted`, `good first issue`
`/good-first-issue` | `good first issue`, `help wanted` | `good first issue`

## Removing labels

Every label command has a `/remove-` form that takes the same values:
`/remove-area bug` removes `area/bug`, `/remove-kind cleanup` removes
`kind/cleanup`, `/remove-priority low` removes `priority/low`,
`/remove-label help-wanted` removes `help-wanted` and `/remove-level sandbox`
removes `level/sandbox`.
Only values listed under the matching key in `.prowlabels.yaml` are
removed, so these commands can be used by anyone without exposing
labels such as `lgtm`, `hold` or `approved`. A value that is not on
the issue is ignored. Enabling `/kind` in `prow-commands` also enables
`/remove-kind`, and listing only `/remove-kind` enables `/kind` as well.

## Automatic PR labels

To automatically label PRs based on file globs, it's recommended to use the
[GitHub `actions/labeler`](https://github.com/actions/labeler/blob/main/README.md) workflow.
The [Digital Ocean Glob Tool](https://www.digitalocean.com/community/tools/glob)
can be helpful when specifying and building file globs.
