import type { PrefixedLabelCommand } from '../labels/prefixed'
import type { Context } from '../utils/context'
import * as core from '@actions/core'

import * as github from '@actions/github'

import { hold } from '../labels/hold'
import { lgtm } from '../labels/lgtm'
import { addPrefixedLabels, prefixedLabelCommands, removeCommandFor, removePrefixedLabels } from '../labels/prefixed'
import { remove } from '../labels/remove'
import { hasCommand } from '../utils/command'
import { approve } from './approve'
import { assign } from './assign'
import { cc } from './cc'
import { close } from './close'
import { lock } from './lock'
import { meow } from './meow'
import { milestone } from './milestone'
import { reopen } from './reopen'
import { retitle } from './retitle'
import { unassign } from './unassign'
import { uncc } from './uncc'

// Prow-style spellings that are handled by the canonical command's module
const commandAliases: Record<string, string[]> = {
  '/lgtm': ['/remove-lgtm'],
  '/approve': ['/remove-approve'],
  '/hold': ['/unhold', '/remove-hold'],
  ...Object.fromEntries(
    prefixedLabelCommands.map(cmd => [cmd.command, [removeCommandFor(cmd.command)]]),
  ),
}

function canonicalCommand(name: string): string {
  for (const [command, aliases] of Object.entries(commandAliases)) {
    if (aliases.includes(name)) {
      return command
    }
  }
  return name
}

function commandForms(command: string): string[] {
  return [command, ...(commandAliases[command] ?? [])]
}

/**
 * This Method handles any issue comments
 * Note that the github api considers PRs issues
 * A user should define which of the commands they want to run in their workflow yaml
 *
 * @param context - the github context of the current action event
 */
export async function handleIssueComment(context: Context = github.context): Promise<void> {
  const commandConfig = [...new Set(
    core
      .getInput('prow-commands', { required: false })
      .split(/\s+/)
      .filter(command => command !== '')
      .map(canonicalCommand),
  )]
  const commentBody: string = context.payload.comment?.body

  if (commandConfig.length === 0) {
    core.setFailed(
      `please provide a list of space delimited commands / jobs to run. None found`,
    )
    return
  }

  await Promise.all(
    commandConfig.map(async (command) => {
      if (commandForms(command).some(form => hasCommand(form, commentBody))) {
        const prefixed = prefixedLabelCommands.find(cmd => cmd.command === command)
        if (prefixed) {
          return await prefixedLabels(context, prefixed, commentBody).catch(normalizeError)
        }

        switch (command) {
          case '/assign':
            return await assign(context).catch(normalizeError)

          case '/cc':
            return await cc(context).catch(normalizeError)

          case '/uncc':
            return await uncc(context).catch(normalizeError)

          case '/unassign':
            return await unassign(context).catch(normalizeError)

          case '/approve':
            return await approve(context).catch(normalizeError)

          case '/retitle':
            return await retitle(context).catch(normalizeError)

          case '/remove':
            return await remove(context).catch(normalizeError)

          case '/hold':
            return await hold(context).catch(normalizeError)

          case '/lgtm':
            return await lgtm(context).catch(normalizeError)

          case '/close':
            return await close(context).catch(normalizeError)

          case '/lock':
            return await lock(context).catch(normalizeError)

          case '/reopen':
            return await reopen(context).catch(normalizeError)

          case '/milestone':
            return await milestone(context).catch(normalizeError)

          case '/meow':
            return await meow(context).catch(normalizeError)

          default:
            return new Error(
              `could not execute ${command}. May not be supported - please refer to docs`,
            )
        }
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

// a body may carry both '/kind bug' and '/remove-kind cleanup'; removals go first
async function prefixedLabels(context: Context, cmd: PrefixedLabelCommand, body: string): Promise<void> {
  if (hasCommand(removeCommandFor(cmd.command), body)) {
    await removePrefixedLabels(context, cmd)
  }
  if (hasCommand(cmd.command, body)) {
    await addPrefixedLabels(context, cmd)
  }
}

// normalizeError coerces a non-Error rejection so it still fails the Action
function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}
