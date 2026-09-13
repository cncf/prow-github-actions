import type { Context } from '../utils/context'
import type { EventHandler } from '../utils/events'

import * as github from '@actions/github'
import { requireMatchingLabel } from '../plugins/requireMatchingLabel'
import { runEventHandlers } from '../utils/events'

/** handlers that run on every `issues` event */
export const issueEventHandlers: EventHandler[] = [requireMatchingLabel]

/**
 * Dispatches an `issues` event to the registered handlers.
 *
 * @param context - the github context of the current action event
 */
export async function handleIssues(context: Context = github.context): Promise<void> {
  await runEventHandlers('issues', issueEventHandlers, context)
}
