import type { Context } from '../utils/context'

import { platform } from '../platform'
import { labelSync } from './labelSync'
import { cronLgtm } from './lgtm'
import { sweep } from './sweep'

/**
 * This Method handles any cron job events.
 * A user should define which of the jobs they want to run in their workflow yaml
 *
 * @param context - the github context of the current action event
 */
export async function handleCronJobs(context: Context = platform().context()): Promise<void> {
  const runConfig = platform().inputs.get('jobs', { required: false }).split(/\s+/).filter(command => command !== '').map(command => command.toLowerCase())

  if (runConfig.length === 0) {
    runConfig.push('')
  }

  await Promise.all(
    runConfig.map(async (command) => {
      switch (command) {
        case 'lgtm':
          platform().log.debug('running cronLgtm job')
          return await cronLgtm(1, context).catch(async (e) => {
            return e
          })

        case 'label-sync':
          platform().log.debug('running label-sync job')
          return await labelSync(context).catch(async (e) => {
            return e
          })

        case 'sweep':
          platform().log.debug('running sweep job')
          return await sweep(context).catch(async (e) => {
            return e
          })

        case '':
          return new Error(
            `please provide a list of space delimited commands / jobs to run. None found`,
          )

        default:
          return new Error(
            `could not execute ${command}. May not be supported - please refer to docs`,
          )
      }
    }),
  )
    .then((results) => {
      // Check to see if any of the promises failed
      for (const result of results) {
        if (result instanceof Error) {
          throw new TypeError(`error handling cron job: ${result}`)
        }
      }
    })
    .catch((e) => {
      platform().fail(`${e}`)
    })
}
