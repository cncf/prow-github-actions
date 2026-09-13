import type { Context } from '../utils/context'
import type { EventHandler } from '../utils/events'

import * as core from '@actions/core'

import * as github from '@actions/github'
import { blunderbuss } from '../plugins/blunderbuss'
import { ownersLabel } from '../plugins/ownersLabel'
import { requireMatchingLabel } from '../plugins/requireMatchingLabel'
import { tideOnPullRequest } from '../plugins/tide'
import { runEventHandlers } from '../utils/events'
import { onPrLgtm } from './onPrLgtm'

/** handlers that run on every `pull_request` / `pull_request_target` event, next to the `jobs` input */
export const pullRequestHandlers: EventHandler[] = [requireMatchingLabel, ownersLabel, blunderbuss, tideOnPullRequest]

/**
 * This method handles any pull-request configuration for configured workflows:
 * the registered handlers and the `jobs` input. The `lgtm` job only acts on
 * `synchronize` (new commits); every other activity type is logged and skipped.
 * An empty `jobs` input is only an error when no handler is registered either.
 *
 * @param context - the github context of the current action event
 */
export async function handlePullReq(context: Context = github.context): Promise<void> {
  const action: string | undefined = context.payload.action
  const runConfig = core
    .getInput('jobs', { required: false })
    .split(/\s+/)
    .filter(command => command !== '')
    .map(command => command.toLowerCase())

  await runEventHandlers('pull_request', pullRequestHandlers, context)

  if (runConfig.length === 0) {
    if (pullRequestHandlers.length === 0) {
      core.setFailed('please provide a list of space delimited commands / jobs to run. None found')
    }
    return
  }

  await Promise.all(
    runConfig.map(async (command) => {
      core.debug(`${context}`)
      switch (command) {
        case 'lgtm':
          if (action !== 'synchronize') {
            core.debug(`skipping pr lgtm job: ${action} pushes no new commits`)
            return
          }
          core.debug('running pr lgtm new commit job')
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
          throw new TypeError(`error handling issue comment: ${result}`)
        }
      }
    })
    .catch((e) => {
      core.setFailed(`${e}`)
    })
}
