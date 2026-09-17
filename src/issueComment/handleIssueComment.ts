import type { FixedLabelCommand } from '../labels/fixed'
import type { PrefixedLabelCommand } from '../labels/prefixed'
import type { Context } from '../utils/context'
import * as core from '@actions/core'

import * as github from '@actions/github'

import { addFixedLabels, fixedLabelCommands, removeFixedLabels } from '../labels/fixed'
import { hold } from '../labels/hold'
import { lgtm } from '../labels/lgtm'
import { addPrefixedLabels, dynamicPrefixedCommand, labelCommandName, prefixedLabelCommands, removeCommandFor, removePrefixedLabels } from '../labels/prefixed'
import { remove } from '../labels/remove'
import { autoCc } from '../plugins/blunderbuss'
import { checkRequiredLabels } from '../plugins/requireMatchingLabel'
import { tideOnComment } from '../plugins/tide'
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
import { retest, test } from './trigger'
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
  '/check-required-labels': context => checkRequiredLabels(context),
  '/auto-cc': context => autoCc(context),
  '/retest': context => retest(context),
  '/test': context => test(context),
}

// Prow-style spellings that are handled by the canonical command's module
const commandAliases: Record<string, string[]> = {
  '/lgtm': ['/remove-lgtm'],
  '/approve': ['/remove-approve'],
  '/hold': ['/unhold', '/remove-hold'],
  ...Object.fromEntries(
    [...prefixedLabelCommands, ...fixedLabelCommands]
      .map(cmd => [cmd.command, [removeCommandFor(cmd.command)]]),
  ),
}

// any other /<key> names a label section of the prow configuration
function isDynamicLabelCommand(command: string): boolean {
  return command.startsWith('/')
    && labelCommandName.test(command.slice(1))
    && !(command in handlers)
    && !(command in commandAliases)
}

// only a command that may have written a label needs the post-command sweep; the rest stay free of extra calls
const labelWritingHandlers = new Set(['/lgtm', '/approve', '/hold', '/remove'])

function changesLabels(command: string): boolean {
  return labelWritingHandlers.has(command)
    || prefixedLabelCommands.some(cmd => cmd.command === command)
    || fixedLabelCommands.some(cmd => cmd.command === command)
    || isDynamicLabelCommand(command)
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

  const results = await Promise.all(
    commandConfig.map(async (command): Promise<CommandResult> => {
      if (!commandForms(command).some(form => hasCommand(form, commentBody))) {
        return 'unmatched'
      }

      const prefixed = prefixedLabelCommands.find(cmd => cmd.command === command)
      if (prefixed) {
        return await prefixedLabels(context, prefixed, commentBody).catch(normalizeError)
      }

      const fixed = fixedLabelCommands.find(cmd => cmd.command === command)
      if (fixed) {
        return await fixedLabels(context, fixed, commentBody).catch(normalizeError)
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
    }),
  )

  const failures: string[] = []
  const commandError = results.find(result => result instanceof Error)
  if (commandError !== undefined) {
    failures.push(`${new TypeError(`error handling issue comment: ${commandError}`)}`)
  }

  if (commandConfig.some((command, i) => results[i] !== 'unmatched' && changesLabels(command))) {
    const alreadyChecked = commandConfig.includes('/check-required-labels') && hasCommand('/check-required-labels', commentBody)
    failures.push(...await sweep(context, alreadyChecked))
  }

  if (failures.length > 0) {
    core.setFailed(failures.join('; '))
  }
}

type CommandResult = 'unmatched' | void | Error

// The bot's own label writes fire no `labeled`/`unlabeled` event, so what those events would
// trigger runs here, after the commands: the needs-* re-check, then the merge gate.
async function sweep(context: Context, alreadyChecked: boolean): Promise<string[]> {
  const failures: string[] = []
  const steps: (() => Promise<void>)[] = [
    ...(alreadyChecked ? [] : [() => checkRequiredLabels(context)]),
    () => tideOnComment(context),
  ]

  for (const step of steps) {
    try {
      await step()
    }
    catch (e) {
      failures.push(`${normalizeError(e)}`)
    }
  }

  return failures
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

async function fixedLabels(context: Context, cmd: FixedLabelCommand, body: string): Promise<void> {
  if (hasCommand(removeCommandFor(cmd.command), body)) {
    await removeFixedLabels(context, cmd)
  }
  if (hasCommand(cmd.command, body)) {
    await addFixedLabels(context, cmd)
  }
}

// normalizeError coerces a non-Error rejection so it still fails the Action
function normalizeError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error))
}
