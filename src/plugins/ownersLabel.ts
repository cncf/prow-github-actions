import type { Context } from '../utils/context'

import * as core from '@actions/core'
import * as github from '@actions/github'

import { getCurrentLabels, labelIssue, repoLabelNames } from '../utils/labeling'
import { newOctokit } from '../utils/octokit'
import { loadPullRequestOwners } from '../utils/pullRequestOwners'

const triggerActions = new Set(['opened', 'reopened', 'synchronize'])

/**
 * ownersLabel is the `pull_request` handler modelled on Prow's owners-label
 * plugin: on `opened`, `reopened` and `synchronize` it adds the `labels:`
 * declared by the OWNERS files covering the changed files. Labels the
 * repository does not have are logged and skipped; nothing is ever removed.
 *
 * @param context - the github context of the current action event
 */
export async function ownersLabel(context: Context = github.context): Promise<void> {
  const action: string | undefined = context.payload.action
  if (action === undefined || !triggerActions.has(action)) {
    core.debug(`owners-label: skipping ${action} action`)
    return
  }

  const pullNumber: number | undefined = context.payload.pull_request?.number
  if (pullNumber === undefined) {
    throw new Error(`github context payload missing pull request: ${JSON.stringify(context.payload)}`)
  }

  const token = core.getInput('github-token', { required: true })
  const octokit = newOctokit(token)

  const { perFile } = await loadPullRequestOwners(octokit, context, pullNumber)
  const declared = new Set<string>()
  for (const owners of perFile.values()) {
    owners?.labels.forEach(label => declared.add(label))
  }
  if (declared.size === 0) {
    core.debug('owners-label: no OWNERS file covering the changed files declares labels')
    return
  }

  const current = new Set((await getCurrentLabels(octokit, context, pullNumber)).map(lower))
  const missing = [...declared].filter(label => !current.has(lower(label)))
  if (missing.length === 0) {
    core.debug(`owners-label: #${pullNumber} already carries ${[...declared].join(', ')}`)
    return
  }

  let known: Set<string>
  try {
    known = new Set((await repoLabelNames(octokit, context)).map(lower))
  }
  catch (e) {
    throw new Error(`could not list the repository labels: ${e}`)
  }

  const toAdd = missing.filter((label) => {
    if (known.has(lower(label))) {
      return true
    }
    core.info(`owners-label: skipping label ${label} declared in OWNERS: repository doesn't have it (run label-sync)`)
    return false
  })
  if (toAdd.length === 0) {
    return
  }

  await labelIssue(octokit, context, pullNumber, toAdd)
}

function lower(label: string): string {
  return label.toLowerCase()
}
