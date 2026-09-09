# Labeling

Prow github actions expects the file `.prowlabels.yaml` to be in the root of the project.
This is needed for most labeling commands and jobs.
All of the following examples can be placed simultaneously in the `.prowlabels.yaml` file.

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
A later `/priority` command replaces any existing `priority/*` labels
instead of stacking them.

## Removing labels

Every prefixed command has a `/remove-` form that takes the same values:
`/remove-area bug` removes `area/bug`, `/remove-kind cleanup` removes
`kind/cleanup` and `/remove-priority low` removes `priority/low`.
Only values listed under the matching key in `.prowlabels.yaml` are
removed, so these commands can be used by anyone without exposing
labels such as `lgtm`, `hold` or `approved`. A value that is not on
the issue is ignored. Enabling `/kind` in `prow-commands` also enables
`/remove-kind`.

## Automatic PR labels

To automatically label PRs based on file globs, it's recommended to use the
[GitHub `actions/labeler`](https://github.com/actions/labeler/blob/main/README.md) workflow.
The [Digital Ocean Glob Tool](https://www.digitalocean.com/community/tools/glob)
can be helpful when specifying and building file globs.
