# Cron jobs

The following jobs are supported through [cron Github workflows](https://docs.github.com/en/actions/writing-workflows/choosing-when-your-workflow-runs/events-that-trigger-workflows#schedule).

Jobs | Description
--- | ---
`lgtm` | Will attempt to automatically merge a PR with the `lgtm` label. Blocked by the `hold` label. Removed by the [lgtm PR job on pr update](./pr-jobs.md)
`pr-labeler` | **(DEPRECATED)** Labels PRs with labels based on file globs found in `.github/labels.yaml`. See [docs on PR labeler for more info](pr-labeling.md)

> What is the Chron job PR labeler?

This job is a legacy feature of Github Prow bot which would label PRs
based on a chron schedule. This was created since Github at the time did not provide a way
to securely run actions (and therefore code) from PR forks, which could possibly be untrusted.
This chron job runs from _the main branch_ and not forks, therefore preventing any
forked malicious code from being run against the repository.

> Why don't you recommend using it anymore?

Github now has a solution! You can use the [Github labeler](https://github.com/actions/labeler)
which uses a newer action trigger: `pull_request_target`.
This is [documented here](https://github.com/actions/labeler/blob/main/README.md).
The new action trigger event does _not_ run from the forked branch
but rather, runs from the _main branch_. It can be triggered on each occurence of a PR.

Since this is officially supported by Github, I am recommending people use that to label their PRs.

> Why not just remove the chron labeler all together?

I'm keeping this job as part of the API since it may have additional purposes.
The chron job will attempt to run on _all PRs_ in a repository
which may be useful if a repository needs to batch label all their PRs.

However, this has some known limitations. The chron labeler queries Github in 100 batch PRs.
This can trigger github to rate limit the bot.

This job may be run with the following workflow configuration:

```yml
name: Label PRs from globs
on:
  schedule:
    - cron: '0 * * * *'

jobs:
  execute:
    runs-on: ubuntu-latest
    steps:
      - uses: cncf/prow-github-actions@v1
        with:
          jobs: pr-labeler
          github-token: '${{ secrets.GITHUB_TOKEN }}'
```

> Interesting! Where's the historical context?

Refer to this thread and this comment for further discussion on the new action handler:
https://github.com/actions/labeler/issues/12#issuecomment-670967607
