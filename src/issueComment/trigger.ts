import type { Octokit, RestEndpointMethodTypes } from '@octokit/rest'
import type { Context } from '../utils/context'
import process from 'node:process'

import * as core from '@actions/core'
import * as github from '@actions/github'

import { shortSha } from '../plugins/lgtmBinding'
import { assertAuthorizedByOwnersOrMembership } from '../utils/auth'
import { getCommandArgs } from '../utils/command'
import { createComment } from '../utils/comments'
import { getCurrentLabels, labelIssue } from '../utils/labeling'
import { newOctokit } from '../utils/octokit'
import { loadPullRequestOwners } from '../utils/pullRequestOwners'

type WorkflowRun = RestEndpointMethodTypes['actions']['listWorkflowRunsForRepo']['response']['data']['workflow_runs'][number]

/** the label `/ok-to-test` applies; while a pull request carries it, its pending runs are approved on every push and by the sweep */
export const okToTestLabel = 'ok-to-test'

export const actionsPermissionHint = 'grant `actions: write` to the workflow'

const failedConclusions = new Set(['failure', 'cancelled', 'timed_out'])

/**
 * retest re-runs the failed jobs of every completed run on the pull
 * request's head that ended in failure, cancelled or timed_out. Runs in
 * progress are left alone. Authorized like `/lgtm`.
 *
 * @param context - the github actions event context
 */
export async function retest(context: Context = github.context): Promise<void> {
  const cmd = await prepare(context, '/retest')
  if (cmd === undefined) {
    return
  }
  const { octokit, issueNumber, headSha } = cmd

  const runs = await headRuns(octokit, context, headSha)
  const failed = runs.filter(run => run.status === 'completed' && failedConclusions.has(run.conclusion ?? ''))

  if (failed.length === 0) {
    const inProgress = runs.filter(run => run.status !== 'completed').length
    const successful = runs.filter(run => run.status === 'completed' && run.conclusion === 'success').length
    const parts = [
      ...(inProgress > 0 ? [`${inProgress} in progress`] : []),
      ...(successful > 0 ? [`${successful} successful`] : []),
    ]
    const summary = parts.length > 0 ? `: ${parts.join(', ')}` : ''
    await createComment(octokit, context, issueNumber, `No failed GitHub Actions workflow runs on \`${shortSha(headSha)}\`${summary}. Checks from other CI systems cannot be re-run here.`)
    return
  }

  const rerun = await rerunEach(octokit, context, issueNumber, failed, run => octokit.actions.reRunWorkflowFailedJobs({ ...context.repo, run_id: run.id }))
  if (rerun === 0) {
    await createComment(octokit, context, issueNumber, `The failed GitHub Actions workflow runs on \`${shortSha(headSha)}\` are already being re-run.`)
    return
  }

  await react(octokit, context)
}

/**
 * test re-runs whole workflow runs on the head: `/test all` every completed
 * run, `/test <name>` those whose workflow name or file matches, and
 * `/test ?` (or no argument) lists the runs instead. Authorized like `/lgtm`.
 *
 * @param context - the github actions event context
 */
export async function test(context: Context = github.context): Promise<void> {
  const cmd = await prepare(context, '/test')
  if (cmd === undefined) {
    return
  }
  const { octokit, issueNumber, headSha } = cmd
  const args = getCommandArgs('/test', context.payload.comment?.body).map(arg => arg.toLowerCase())

  const runs = await headRuns(octokit, context, headSha)
  if (args.length === 0 || args.includes('?')) {
    await createComment(octokit, context, issueNumber, runTable(headSha, runs))
    return
  }

  const completed = runs.filter(run => run.status === 'completed')
  const selected = args.includes('all')
    ? completed
    : completed.filter(run => args.some(arg => matchesWorkflow(run, arg)))

  if (selected.length === 0) {
    await createComment(octokit, context, issueNumber, `No completed GitHub Actions workflow run on \`${shortSha(headSha)}\` matches \`${args.join(' ')}\`.\n\n${runTable(headSha, runs)}`)
    return
  }

  const rerun = await rerunEach(octokit, context, issueNumber, selected, run => octokit.actions.reRunWorkflow({ ...context.repo, run_id: run.id }))
  if (rerun === 0) {
    await createComment(octokit, context, issueNumber, `The GitHub Actions workflow runs on \`${shortSha(headSha)}\` are already being re-run.`)
    return
  }

  await react(octokit, context)
}

/**
 * okToTest approves the runs waiting for approval on the head (a first-time
 * contributor's fork) and applies the `ok-to-test` label, which keeps
 * approving them on later pushes and in the sweep. Authorized like `/lgtm`,
 * and refused for the pull request author: it is the trust decision.
 *
 * @param context - the github actions event context
 */
export async function okToTest(context: Context = github.context): Promise<void> {
  const cmd = await prepare(context, '/ok-to-test', { refuseAuthor: 'you cannot approve the workflow runs of your own pull request' })
  if (cmd === undefined) {
    return
  }
  const { octokit, issueNumber, headSha } = cmd

  const approved = await approvePendingRuns(octokit, context, issueNumber, headSha)

  const labels = await getCurrentLabels(octokit, context, issueNumber)
  const alreadyLabeled = labels.some(label => label.toLowerCase() === okToTestLabel)
  if (!alreadyLabeled) {
    await labelIssue(octokit, context, issueNumber, [okToTestLabel])
  }

  if (approved === 0 && alreadyLabeled) {
    await createComment(octokit, context, issueNumber, `No workflow runs waiting for approval on \`${shortSha(headSha)}\`.`)
    return
  }

  await react(octokit, context)
}

/**
 * approvePendingRuns approves every run on `headSha` that awaits approval.
 * A 403 names the permission to grant.
 *
 * @param octokit - a hydrated github client
 * @param context - the github actions event context
 * @param number - the pull request number, for the log
 * @param headSha - the pull request's head commit
 * @returns how many runs were approved
 */
export async function approvePendingRuns(octokit: Octokit, context: Context, number: number, headSha: string): Promise<number> {
  const pending = (await headRuns(octokit, context, headSha))
    .filter(run => run.status === 'action_required' || run.conclusion === 'action_required')

  let approved = 0
  for (const run of pending) {
    try {
      await octokit.actions.approveWorkflowRun({ ...context.repo, run_id: run.id })
      approved++
    }
    catch (e) {
      if (isForbidden(e)) {
        throw new Error(`cannot approve workflow runs: ${actionsPermissionHint}`)
      }
      throw new Error(`could not approve run ${run.id} (${run.name}): ${e}`)
    }
  }

  core.info(`trigger: #${number} approved ${approved} run(s) on ${shortSha(headSha)}`)
  return approved
}

/**
 * okToTestOnPullRequest is the `pull_request` handler of the trust marker:
 * on `synchronize` and `reopened` of a pull request carrying `ok-to-test`
 * it approves the runs waiting on the new head.
 *
 * @param context - the github context of the current action event
 */
export async function okToTestOnPullRequest(context: Context = github.context): Promise<void> {
  const action: string | undefined = context.payload.action
  if (action !== 'synchronize' && action !== 'reopened') {
    return
  }

  const pull = context.payload.pull_request
  const labels: unknown = pull?.labels
  if (!Array.isArray(labels) || !labels.some(label => String(label?.name ?? '').toLowerCase() === okToTestLabel)) {
    core.debug('trigger: the pull request does not carry ok-to-test')
    return
  }

  const sha: unknown = pull?.head?.sha
  if (typeof sha !== 'string' || pull?.number === undefined) {
    throw new TypeError(`github context payload missing pull request head: ${JSON.stringify(context.payload)}`)
  }

  const octokit = newOctokit(core.getInput('github-token', { required: true }))
  await approvePendingRuns(octokit, context, pull.number, sha)
}

interface PreparedCommand {
  octokit: Octokit
  issueNumber: number
  headSha: string
}

async function prepare(context: Context, command: string, options: { refuseAuthor?: string } = {}): Promise<PreparedCommand | undefined> {
  const octokit = newOctokit(core.getInput('github-token', { required: true }))
  const issueNumber: number | undefined = context.payload.issue?.number
  const commenter: string = context.payload.comment?.user?.login

  if (issueNumber === undefined) {
    throw new Error(`github context payload missing issue number: ${context.payload}`)
  }

  if (context.payload.issue?.pull_request === undefined) {
    await createComment(octokit, context, issueNumber, `\`${command}\` only applies to pull requests.`)
    return undefined
  }

  if (options.refuseAuthor !== undefined && commenter === context.payload.issue?.user?.login) {
    await refuse(octokit, context, issueNumber, options.refuseAuthor)
  }

  try {
    await assertAuthorizedByOwnersOrMembership(octokit, context, 'reviewers', commenter)
  }
  catch (e) {
    await refuse(octokit, context, issueNumber, `Cannot ${command} because ${e}`, e)
  }

  const { headSha } = await loadPullRequestOwners(octokit, context, issueNumber)
  return { octokit, issueNumber, headSha }
}

// the reusable workflow runs inside the caller's workflow, whose name GITHUB_WORKFLOW carries;
// re-running or approving that run would re-run this very command
async function headRuns(octokit: Octokit, context: Context, headSha: string): Promise<WorkflowRun[]> {
  const current = process.env.GITHUB_WORKFLOW
  let runs: WorkflowRun[]
  try {
    runs = await octokit.paginate(octokit.actions.listWorkflowRunsForRepo, { ...context.repo, head_sha: headSha, per_page: 100 })
  }
  catch (e) {
    throw new Error(`could not list the workflow runs of ${shortSha(headSha)}: ${e}`)
  }
  return runs.filter(run => current === undefined || run.name !== current)
}

async function rerunEach(
  octokit: Octokit,
  context: Context,
  issueNumber: number,
  runs: WorkflowRun[],
  rerun: (run: WorkflowRun) => Promise<unknown>,
): Promise<number> {
  let count = 0
  for (const run of runs) {
    try {
      await rerun(run)
      count++
    }
    catch (e) {
      if (isConflict(e)) {
        core.debug(`trigger: run ${run.id} (${run.name}) is not completed or already re-running: ${e}`)
        continue
      }
      if (isForbidden(e)) {
        await refuse(octokit, context, issueNumber, `cannot re-run workflows: ${actionsPermissionHint}`)
      }
      throw new Error(`could not re-run ${run.name} (${run.id}): ${e}`)
    }
  }
  return count
}

function matchesWorkflow(run: WorkflowRun, arg: string): boolean {
  if ((run.name ?? '').toLowerCase() === arg) {
    return true
  }
  const path = run.path.toLowerCase()
  return [arg, `${arg}.yml`, `${arg}.yaml`].some(file => path === file || path.endsWith(`/${file}`))
}

function runTable(headSha: string, runs: WorkflowRun[]): string {
  const rows = runs.map(run => `\`${run.name ?? run.path}\` | ${run.status ?? ''} | ${run.conclusion ?? ''}`)
  return [
    `Workflow runs on \`${shortSha(headSha)}\`:`,
    '',
    'workflow | status | conclusion',
    '--- | --- | ---',
    ...(rows.length > 0 ? rows : ['_none_ | |']),
  ].join('\n')
}

async function react(octokit: Octokit, context: Context): Promise<void> {
  const commentId: number | undefined = context.payload.comment?.id
  if (commentId === undefined) {
    return
  }
  try {
    await octokit.reactions.createForIssueComment({ ...context.repo, comment_id: commentId, content: 'rocket' })
  }
  catch (e) {
    core.warning(`trigger: could not react to the comment: ${e}`)
  }
}

async function refuse(octokit: Octokit, context: Context, issueNumber: number, msg: string, cause: unknown = new Error(msg)): Promise<never> {
  core.error(msg)
  try {
    await createComment(octokit, context, issueNumber, msg)
  }
  catch (commentE) {
    core.error(`Could not comment with an auth error: ${commentE}`)
  }
  throw cause
}

function isForbidden(error: unknown): boolean {
  return statusOf(error) === 403
}

function isConflict(error: unknown): boolean {
  return statusOf(error) === 409
}

function statusOf(error: unknown): unknown {
  return typeof error === 'object' && error !== null && 'status' in error ? error.status : undefined
}
