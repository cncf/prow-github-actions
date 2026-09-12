import type { Context } from '../utils/context'
import type { EventHandler } from '../utils/events'

import * as github from '@actions/github'
import { runEventHandlers } from '../utils/events'

/** handlers that run on every `pull_request_review` event; empty for now */
export const pullRequestReviewHandlers: EventHandler[] = []

/**
 * Dispatches a `pull_request_review` event to the registered handlers.
 *
 * @param context - the github context of the current action event
 */
export async function handlePullReqReview(context: Context = github.context): Promise<void> {
  await runEventHandlers('pull_request_review', pullRequestReviewHandlers, context)
}
