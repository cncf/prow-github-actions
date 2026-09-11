import type { PrefixedLabelCommand } from '../labels/prefixed'
import type { Context } from '../utils/context'
import * as core from '@actions/core'

import * as github from '@actions/github'

import { hold } from '../labels/hold'
import { lgtm } from '../labels/lgtm'
import { addPrefixedLabels, dynamicPrefixedCommand, labelCommandName, prefixedLabelCommands, removeCommandFor, removePrefixedLabels } from '../labels/prefixed'
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

// hand-written commands; looked up lazily so the module bindings stay spy-able
const handlers: Record<string, (context: Context) => Promise<void>> = {
  '/assign': context => assign(context),
  '/cc': context => cc(context),
  '/uncc': context => uncc(context),
  '/unassign': context => unassign(context),
  '/approve': context => approve(context),
  '/retitle': context => retitle(context),
  '/remove': context => remove(context),
  '/hold': context => hold(context),
  '/lgtm': context => lgtm(context),
  '/close': context => close(context),
  '/lock': context => lock(context),
  '/reopen': context => reopen(context),
  '/milestone': context => milestone(context),
  '/meow': context => meow(context),
}

// Prow-style spellings that are handled by the canonical command's module
const commandAliases: Record<string, string[]> = {
  '/lgtm': ['/remove-lgtm'],
  '/approve': ['/remove-approve'],
  '/hold': ['/unhold', '/remove-hold'],
  ...Object.fromEntries(
    prefixedLabelCommands.map(cmd => [cmd.command, [removeCommandFor(cmd.command)]]),
  ),
}

// any other /<key> names a .prowlabels.yaml section
function isDynamicLabelCommand(command: string): boolean {
  return command.startsWith('/')
    && labelCommandName.test(command.slice(1))
    && !(command in handlers)
    && !(command in commandAliases)
}

function canonicalCommand(name: string): string {
  // the alias table wins so /remove-lgtm, /remove-hold and friends keep their bases
  for (const [command, aliases] of Object.entries(commandAliases)) {
    if (aliases.includes(name)) {
      return command
    }
  }

  const base = name.replace(/^\/remove-/, '/')
  return base !== name && isDynamicLabelCommand(base) ? base : name
}

function commandForms(command: string): string[] {
  if (isDynamicLabelCommand(command)) {
    return [command, removeCommandFor(command)]
  }
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
      .map(command => canonicalCommand(command.toLowerCase())),
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

        const handler = handlers[command]
        if (handler) {
          return await handler(context).catch(normalizeError)
        }

        if (isDynamicLabelCommand(command)) {
          return await prefixedLabels(context, dynamicPrefixedCommand(command.slice(1)), commentBody).catch(normalizeError)
        }

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
