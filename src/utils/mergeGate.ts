import type { ResolvedTide } from './config'

import { matchesLabelPattern } from './labelMatch'

export interface MergeGateResult {
  ok: boolean
  /** why the PR is skipped, ex: `missing lgtm` or `blocked by do-not-merge/hold` */
  reason?: string
}

/**
 * meetsMergeGate decides, like Prow's tide query, whether a pull request's
 * labels allow merging: every `tide.labels` pattern must match at least one
 * label and no `tide.missing_labels` pattern may match any label.
 *
 * @param labels - the labels on the pull request
 * @param tide - the resolved tide configuration
 */
export function meetsMergeGate(labels: string[], tide: ResolvedTide): MergeGateResult {
  const missing = tide.labels.find(pattern => !labels.some(label => matchesLabelPattern(pattern, label)))
  if (missing !== undefined) {
    return { ok: false, reason: `missing ${missing}` }
  }

  const blocking = labels.find(label => tide.missing_labels.some(pattern => matchesLabelPattern(pattern, label)))
  if (blocking !== undefined) {
    return { ok: false, reason: `blocked by ${blocking}` }
  }

  return { ok: true }
}
