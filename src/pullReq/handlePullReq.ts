import type { Context } from '../utils/context'
import type { EventHandler } from '../utils/events'

import { okToTestOnPullRequest } from '../issueComment/trigger'
import { platform } from '../platform'
import { approveOnPullRequest } from '../plugins/approve'
import { blunderbuss } from '../plugins/blunderbuss'
import { lgtmOnPullRequest } from '../plugins/lgtmBinding'
import { ownersLabel } from '../plugins/ownersLabel'
import { requireMatchingLabel } from '../plugins/requireMatchingLabel'
import { tideOnPullRequest } from '../plugins/tide'
import { runEventHandlers, skipReadOnlyForkRun } from '../utils/events'
import { onPrLgtm } from './onPrLgtm'

/** handlers that run on every `pull_request` / `pull_request_target` event, in this order, next to the `jobs` input; lgtm binds a hand-applied label and approve applies its label before tide reads them; ok-to-test approves the pending runs of a trusted pull request */
export const pullRequestHandlers: EventHandler[] = [requireMatchingLabel, ownersLabel, blunderbuss, lgtmOnPullRequest, approveOnPullRequest, okToTestOnPullRequest, tideOnPullRequest]

/**
 * This method handles any pull-request configuration for configured workflows:
 * the registered handlers and the `jobs` input. The `lgtm` job only acts on
 * `synchronize` (new commits); every other activity type is logged and skipped.
 * An empty `jobs` input is not an error: the registered handlers still run.
 * A `pull_request` run for a fork pull request has a read-only token and
 * returns before any handler; the `sweep` job covers it.
 *
 * @param context - the github context of the current action event
 */
export async function handlePullReq(context: Context = platform().context()): Promise<void> {
  if (skipReadOnlyForkRun(context)) {
    return
  }

  const action: string | undefined = context.payload.action
  const runConfig = platform().inputs.get('jobs', { required: false }).split(/\s+/).filter(command => command !== '').map(command => command.toLowerCase())

  await runEventHandlers('pull_request', pullRequestHandlers, context)

  if (runConfig.length === 0) {
    return
  }

  await Promise.all(
    runConfig.map(async (command) => {
      platform().log.debug(`${context}`)
      switch (command) {
        case 'lgtm':
          if (action !== 'synchronize') {
            platform().log.debug(`skipping pr lgtm job: ${action} pushes no new commits`)
            return
          }
          platform().log.debug('running pr lgtm new commit job')
          return await onPrLgtm(context).catch(async (e) => {
            return e
          })

        default:
          return new Error(
            `could not execute ${command}. May not be supported - please refer to docs`,
          )
      }
    }),
  )
    .then((results) => {
      for (const result of results) {
        if (result instanceof Error) {
          throw new TypeError(`error handling pull request: ${result}`)
        }
      }
    })
    .catch((e) => {
      platform().fail(`${e}`)
    })
}
