import type { Octokit } from '@octokit/rest'
import type { Context } from '../utils/context'
import type { EventHandler } from '../utils/events'

import * as github from '@actions/github'
import { runEventHandlers } from '../utils/events'

/** handlers that run on every `check_suite` and `status` event; empty until event-driven merging lands */
export const checkSuiteHandlers: EventHandler[] = []

/**
 * Dispatches a `check_suite` or legacy commit `status` event to the registered handlers.
 *
 * @param context - the github context of the current action event
 */
export async function handleCheckSuite(context: Context = github.context): Promise<void> {
  await runEventHandlers(context.eventName, checkSuiteHandlers, context)
}

/**
 * Lists the numbers of the open pull requests whose head is the given commit,
 * paging through `pulls.list` until a page comes back empty.
 *
 * @param octokit - a hydrated github client
 * @param context - the github context of the current action event
 * @param sha - the head commit to look up
 */
export async function pullRequestsForSha(octokit: Octokit, context: Context, sha: string): Promise<number[]> {
  const numbers: number[] = []

  for (let page = 1; ; page++) {
    const { data } = await octokit.pulls.list({
      ...context.repo,
      state: 'open',
      per_page: 100,
      page,
    })
    if (data.length === 0) {
      return numbers
    }
    numbers.push(...data.filter(pr => pr.head.sha === sha).map(pr => pr.number))
  }
}
