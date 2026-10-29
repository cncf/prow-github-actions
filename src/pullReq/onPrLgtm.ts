import type { Context } from '../utils/context'

import { platform } from '../platform'
import { getCurrentLabels, removeLabels } from '../utils/labeling'
import { newOctokitFromInputs } from '../utils/octokit'

/**
 * Removes the 'lgtm' label after a pull request event
 *
 * @param context - The github actions event context
 */
export async function onPrLgtm(context: Context): Promise<void> {
  const octokit = newOctokitFromInputs()

  const prNumber: number | undefined = context.payload.pull_request?.number

  if (prNumber === undefined) {
    throw new Error(
      `github context payload missing pr number: ${JSON.stringify(context.payload)}`,
    )
  }

  let currentLabels: string[] = []
  try {
    currentLabels = await getCurrentLabels(octokit, context, prNumber)
    platform().log.debug(`remove-lgtm: found labels for issue ${currentLabels}`)
  }
  catch (e) {
    throw new Error(`could not get labels from issue: ${e}`)
  }

  if (currentLabels.includes('lgtm')) {
    await removeLabels(octokit, context, prNumber, ['lgtm'])
  }
}
