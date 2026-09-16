import type { Context } from '../utils/context'
import type { EventHandler } from '../utils/events'

import * as github from '@actions/github'
import { approveOnReview } from '../plugins/approve'
import { tideOnReview } from '../plugins/tide'
import { runEventHandlers, skipReadOnlyForkRun } from '../utils/events'

/** handlers that run on every `pull_request_review` event, in this order: approve first so tide sees the label */
export const pullRequestReviewHandlers: EventHandler[] = [approveOnReview, tideOnReview]

/**
 * Dispatches a `pull_request_review` event to the registered handlers. A
 * review on a fork pull request comes with a read-only token and returns
 * before any handler; the `sweep` job covers it.
 *
 * @param context - the github context of the current action event
 */
export async function handlePullReqReview(context: Context = github.context): Promise<void> {
  if (skipReadOnlyForkRun(context)) {
    return
  }

  await runEventHandlers('pull_request_review', pullRequestReviewHandlers, context)
}
