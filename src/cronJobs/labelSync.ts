import type { Octokit } from '@octokit/rest'
import type { LabelValue } from '../utils/config'
import type { Context } from '../utils/context'

import * as core from '@actions/core'
import * as github from '@actions/github'

import { loadProwConfig } from '../utils/config'
import { desiredLabels } from '../utils/labelCatalog'
import { newOctokit } from '../utils/octokit'

export interface LabelSyncFailure {
  name: string
  message: string
}

export interface LabelSyncResult {
  created: string[]
  updated: string[]
  unchanged: number
  failures: LabelSyncFailure[]
}

interface RepoLabel {
  name: string
  color: string
  description?: string | null
}

type LabelPatch = Partial<Pick<LabelValue, 'color' | 'description'>>

/**
 * labelSync creates the labels the prow configuration describes and updates
 * the color or description of those that drifted. It never deletes or
 * renames a label. With the `dry-run` input set it only logs what would
 * change. Every label is attempted; the run fails at the end if any write
 * was refused.
 *
 * @param context - the github actions event context
 */
export async function labelSync(context: Context = github.context): Promise<LabelSyncResult> {
  const token = core.getInput('github-token', { required: true })
  const octokit = newOctokit(token)
  const dryRun = core.getInput('dry-run', { required: false }).trim().toLowerCase() === 'true'

  const config = await loadProwConfig(octokit, context)
  const desired = desiredLabels(config)
  core.debug(`label-sync: ${desired.length} labels from ${config.sources.length === 0 ? 'the built-in defaults only' : config.sources.join(', ')}`)

  let existing: RepoLabel[]
  try {
    existing = await octokit.paginate(octokit.issues.listLabelsForRepo, { ...context.repo, per_page: 100 })
  }
  catch (e) {
    throw new Error(`could not list the repository labels: ${e}`)
  }
  const byName = new Map(existing.map(label => [label.name.toLowerCase(), label]))

  const result: LabelSyncResult = { created: [], updated: [], unchanged: 0, failures: [] }
  const plan = { create: [] as string[], update: [] as string[] }

  for (const label of desired) {
    const current = byName.get(label.name.toLowerCase())

    if (current === undefined) {
      plan.create.push(label.name)
      if (!dryRun) {
        await write(result, label.name, result.created, () => createLabel(octokit, context, label))
      }
      continue
    }

    const patch = drift(label, current)
    if (patch === undefined) {
      result.unchanged++
      continue
    }

    plan.update.push(`${current.name} (${Object.keys(patch).join(', ')})`)
    if (!dryRun) {
      await write(result, current.name, result.updated, () => updateLabel(octokit, context, current.name, patch))
    }
  }

  if (dryRun) {
    core.info(`label-sync (dry-run): would create ${plan.create.length} [${plan.create.join(', ')}], would update ${plan.update.length} [${plan.update.join(', ')}], unchanged ${result.unchanged}`)
    return result
  }

  core.info(`label-sync: created ${result.created.length} [${result.created.join(', ')}], updated ${result.updated.length} [${result.updated.join(', ')}], unchanged ${result.unchanged}, failed ${result.failures.length}`)

  if (result.failures.length > 0) {
    const list = result.failures.map(f => `${f.name} (${f.message})`).join(', ')
    throw new Error(`${result.failures.length} label(s) could not be synced: ${list}`)
  }

  return result
}

// a refused write is logged and recorded so the remaining labels are still attempted
async function write(result: LabelSyncResult, name: string, done: string[], action: () => Promise<unknown>): Promise<void> {
  try {
    await action()
    done.push(name)
  }
  catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    core.error(`label-sync: could not sync ${name}: ${message}`)
    result.failures.push({ name, message })
  }
}

function createLabel(octokit: Octokit, context: Context, label: LabelValue): Promise<unknown> {
  return octokit.issues.createLabel({
    ...context.repo,
    name: label.name,
    ...(label.color === undefined ? {} : { color: label.color }),
    ...(label.description === undefined ? {} : { description: label.description }),
  })
}

function updateLabel(octokit: Octokit, context: Context, name: string, patch: LabelPatch): Promise<unknown> {
  return octokit.issues.updateLabel({ ...context.repo, name, ...patch })
}

// the fields of `desired` that the repository's label does not match; undefined when in sync
function drift(desired: LabelValue, current: RepoLabel): LabelPatch | undefined {
  const patch: LabelPatch = {}

  if (desired.color !== undefined && desired.color.toLowerCase() !== current.color.toLowerCase()) {
    patch.color = desired.color
  }
  if (desired.description !== undefined && desired.description !== (current.description ?? '')) {
    patch.description = desired.description
  }

  return Object.keys(patch).length === 0 ? undefined : patch
}
