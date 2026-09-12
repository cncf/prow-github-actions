import type { Octokit } from '@octokit/rest'
import type { Context } from '../utils/context'
import type { LabelConfig, LabelSection } from '../utils/labeling'
import * as core from '@actions/core'

import { getCommandArgs } from '../utils/command'
import { addPrefix, getCurrentLabels, getLabelConfig, labelIssue, removeLabels } from '../utils/labeling'
import { newOctokit } from '../utils/octokit'

export interface PrefixedLabelCommand {
  /** the slash command, ex: '/kind' */
  command: string
  /** label prefix, ex: 'kind' yields 'kind/<value>'; '' applies labels verbatim */
  prefix: string
  /** label section of the prow configuration listing the allowed values */
  allowlistKey: string
  /** replace any existing '<prefix>/*' labels instead of stacking them */
  exclusive?: boolean
  /** built-in values used when the yaml has no `allowlistKey` section */
  defaultValues?: string[]
}

export const prefixedLabelCommands: PrefixedLabelCommand[] = [
  { command: '/area', prefix: 'area', allowlistKey: 'area' },
  { command: '/kind', prefix: 'kind', allowlistKey: 'kind' },
  { command: '/priority', prefix: 'priority', allowlistKey: 'priority', exclusive: true },
  { command: '/label', prefix: '', allowlistKey: 'labels' },
  { command: '/lifecycle', prefix: 'lifecycle', allowlistKey: 'lifecycle', exclusive: true, defaultValues: ['frozen', 'stale', 'rotten'] },
  { command: '/stage', prefix: 'stage', allowlistKey: 'stage', exclusive: true, defaultValues: ['alpha', 'beta', 'stable'] },
  { command: '/status', prefix: 'status', allowlistKey: 'status', exclusive: true, defaultValues: ['approved-for-milestone', 'in-progress', 'in-review'] },
]

// a label section name usable as a slash command: lower-case letters, digits and dashes
export const labelCommandName = /^[a-z][a-z0-9-]*$/

// labels with dedicated, authorization-gated commands; never reachable through /label
const protectedLabels = ['lgtm', 'hold', 'approved']
const protectedPrefixes = ['do-not-merge/']

export function isProtectedLabel(label: string): boolean {
  const lower = label.toLowerCase()
  return protectedLabels.includes(lower) || protectedPrefixes.some(prefix => lower.startsWith(prefix))
}

/**
 * dynamicPrefixedCommand builds the command for an arbitrary label section
 * so that `/<key> value` labels the issue with '<key>/value'
 *
 * @param name - the top level key, ex: 'level'
 */
export function dynamicPrefixedCommand(name: string): PrefixedLabelCommand {
  return { command: `/${name}`, prefix: name, allowlistKey: name }
}

/**
 * removeCommandFor returns the Prow-style removal spelling of a label command
 * Ex: '/kind' -> '/remove-kind'
 *
 * @param command - the add form of the command
 */
export function removeCommandFor(command: string): string {
  return `/remove-${command.slice(1)}`
}

/**
 * addPrefixedLabels labels the issue with '<prefix>/<value>' for every value
 * that is both in the comment and in the configured allowlist.
 * When the command is exclusive, existing '<prefix>/*' labels that were not
 * requested are removed first.
 *
 * @param context - the github actions event context
 * @param cmd - the command definition
 */
export async function addPrefixedLabels(context: Context, cmd: PrefixedLabelCommand): Promise<void> {
  const token = core.getInput('github-token', { required: true })
  const octokit = newOctokit(token)

  const issueNumber = requireIssueNumber(context)
  const commentBody: string = context.payload.comment?.body

  const section = await allowlistFor(octokit, context, cmd)
  const labels = requestedLabels(cmd, cmd.command, commentBody, section.values)

  if (section.exclusive) {
    const currentLabels = await currentIssueLabels(octokit, context, issueNumber, cmd.command)

    const stale = currentLabels.filter((label) => {
      return label.toLowerCase().startsWith(`${cmd.prefix.toLowerCase()}/`)
        && !labels.some(requested => sameLabel(requested, label))
    })

    if (stale.length > 0) {
      await removeLabels(octokit, context, issueNumber, stale)
    }
  }

  await labelIssue(octokit, context, issueNumber, labels)
}

/**
 * removePrefixedLabels removes '<prefix>/<value>' for every value in the
 * /remove-<command> line that is in the configured allowlist and
 * currently on the issue. Labels owned by other commands (lgtm, hold,
 * approved, do-not-merge/*) are refused even when the allowlist names them.
 *
 * @param context - the github actions event context
 * @param cmd - the command definition
 */
export async function removePrefixedLabels(context: Context, cmd: PrefixedLabelCommand): Promise<void> {
  const token = core.getInput('github-token', { required: true })
  const octokit = newOctokit(token)

  const issueNumber = requireIssueNumber(context)
  const commentBody: string = context.payload.comment?.body
  const command = removeCommandFor(cmd.command)

  const section = await allowlistFor(octokit, context, cmd)
  const labels = requestedLabels(cmd, command, commentBody, section.values)
  const currentLabels = await currentIssueLabels(octokit, context, issueNumber, command)

  const present = currentLabels.filter(label => labels.some(requested => sameLabel(requested, label)))

  if (present.length === 0) {
    core.debug(`${command.slice(1)}: none of ${labels} are on the issue`)
    return
  }

  await removeLabels(octokit, context, issueNumber, present)
}

function requireIssueNumber(context: Context): number {
  const issueNumber: number | undefined = context.payload.issue?.number

  if (issueNumber === undefined) {
    throw new Error(
      `github context payload missing issue number: ${context.payload}`,
    )
  }

  return issueNumber
}

/**
 * sectionFor resolves the label section a command reads: the yaml section
 * wins over the built-in defaults, and a yaml `exclusive` wins over the
 * registry. Undefined when neither exists.
 *
 * @param labels - the label sections of the prow configuration
 * @param cmd - the command definition
 */
export function sectionFor(labels: LabelConfig, cmd: PrefixedLabelCommand): LabelSection | undefined {
  const section = labels[cmd.allowlistKey]

  if (section) {
    return { ...section, exclusive: section.exclusive ?? cmd.exclusive }
  }

  if (cmd.defaultValues) {
    return {
      values: cmd.defaultValues,
      exclusive: cmd.exclusive,
      definitions: cmd.defaultValues.map(name => ({ name })),
    }
  }

  return undefined
}

async function allowlistFor(
  octokit: Octokit,
  context: Context,
  cmd: PrefixedLabelCommand,
): Promise<Required<Pick<LabelSection, 'values' | 'exclusive'>>> {
  const key = cmd.allowlistKey

  try {
    const labels = await getLabelConfig(octokit, context)
    const section = sectionFor(labels, cmd)

    if (section === undefined) {
      throw new Error(`${key}: yaml malformed, expected '${key}' top level key`)
    }

    core.debug(`${key}: ${key in labels ? 'found' : 'using built-in'} labels ${section.values}`)
    return { values: section.values, exclusive: section.exclusive ?? false }
  }
  catch (e) {
    throw new Error(`could not get labels from yaml: ${e}`)
  }
}

function requestedLabels(
  cmd: PrefixedLabelCommand,
  command: string,
  commentBody: string,
  allowed: string[],
): string[] {
  const args = getCommandArgs(command, commentBody)
  const canonical = new Map(allowed.map(value => [value.toLowerCase(), value]))
  const values = args
    .map(arg => canonical.get(arg.toLowerCase()))
    .filter((value): value is string => value !== undefined)
  const labels = addPrefix(cmd.prefix, [...new Set(values)])

  // no arguments after command provided
  if (labels.length === 0) {
    throw new Error(`${command.slice(1)}: command args missing from body`)
  }

  if (cmd.prefix === '') {
    const offender = labels.find(isProtectedLabel)
    if (offender !== undefined) {
      throw new Error(`${command.slice(1)}: ${offender} is managed by its own command and cannot be changed with ${command}`)
    }
  }

  return labels
}

// GitHub label names are case-insensitive, as are Prow's comparisons
export function sameLabel(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase()
}

async function currentIssueLabels(
  octokit: Octokit,
  context: Context,
  issueNumber: number,
  command: string,
): Promise<string[]> {
  try {
    const currentLabels = await getCurrentLabels(octokit, context, issueNumber)
    core.debug(`${command.slice(1)}: found labels for issue ${currentLabels}`)
    return currentLabels
  }
  catch (e) {
    throw new Error(`could not get labels from issue: ${e}`)
  }
}
