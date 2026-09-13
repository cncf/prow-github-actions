import type { Octokit } from '@octokit/rest'
import type { Context } from '../utils/context'
import * as core from '@actions/core'

import * as github from '@actions/github'

import { getCommandArgs, hasCommand, hasKeyword } from '../utils/command'
import { loadProwConfig, resolveHoldLabel } from '../utils/config'
import { getCurrentLabels, labelIssue, removeLabels } from '../utils/labeling'
import { newOctokit } from '../utils/octokit'

// the label /hold applied before it adopted Prow's do-not-merge/hold; cancel keeps releasing it
export const legacyHoldLabel = 'hold'

/**
 * /hold adds the hold label (`hold.label`, Prow's `do-not-merge/hold` by default).
 * /hold cancel, /unhold and /remove-hold remove it, and the legacy `hold` label.
 * Note - the label blocks automatic merging through `tide.missing_labels`.
 *
 * @param context - the github actions event context
 */
export async function hold(context: Context = github.context): Promise<void> {
  const token = core.getInput('github-token', { required: true })
  const octokit = newOctokit(token)

  const issueNumber: number | undefined = context.payload.issue?.number
  const commentBody: string = context.payload.comment?.body

  if (issueNumber === undefined) {
    throw new Error(
      `github context payload missing issue number: ${context.payload}`,
    )
  }

  const config = await loadProwConfig(octokit, context)
  const holdLabel = resolveHoldLabel(config.hold)

  const cancel = hasCommand('/unhold', commentBody)
    || hasCommand('/remove-hold', commentBody)
    || (hasCommand('/hold', commentBody) && hasKeyword(getCommandArgs('/hold', commentBody), 'cancel'))

  if (cancel) {
    await cancelHold(octokit, context, issueNumber, holdLabel)
    return
  }

  await labelIssue(octokit, context, issueNumber, [holdLabel])
}

async function cancelHold(
  octokit: Octokit,
  context: Context,
  issueNumber: number,
  holdLabel: string,
): Promise<void> {
  let currentLabels: string[]
  try {
    currentLabels = await getCurrentLabels(octokit, context, issueNumber)
  }
  catch (e) {
    throw new Error(`could not get labels from issue: ${e}`)
  }

  const wanted = new Set([holdLabel, legacyHoldLabel].map(name => name.toLowerCase()))
  const present = currentLabels.filter(label => wanted.has(label.toLowerCase()))

  if (present.length === 0) {
    core.debug(`could not find ${holdLabel} or ${legacyHoldLabel} to remove`)
    return
  }

  try {
    await removeLabels(octokit, context, issueNumber, present)
  }
  catch (e) {
    throw new Error(`could not remove the hold label: ${e}`)
  }
}
