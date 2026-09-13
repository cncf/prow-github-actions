import type { Context } from '../utils/context'
import type { EventHandler } from '../utils/events'

import * as github from '@actions/github'
import { tideOnCheckSuite } from '../plugins/tide'
import { runEventHandlers } from '../utils/events'

export { pullRequestsForSha } from '../utils/pulls'

/** handlers that run on every `check_suite` and `status` event */
export const checkSuiteHandlers: EventHandler[] = [tideOnCheckSuite]

/**
 * Dispatches a `check_suite` or legacy commit `status` event to the registered handlers.
 *
 * @param context - the github context of the current action event
 */
export async function handleCheckSuite(context: Context = github.context): Promise<void> {
  await runEventHandlers(context.eventName, checkSuiteHandlers, context)
}
