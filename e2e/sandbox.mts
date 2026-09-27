// End-to-end run of the committed dist/index.js against a real GitHub sandbox repository.
//
// Every step posts the real comment (or makes the real change) through the API, rebuilds the
// event payload GitHub would deliver from the real objects, runs the bundle with it as a child
// process pointed at api.github.com, and asserts on the sandbox's resulting state. Nothing is
// mocked, so a changed API or a regression in the bot fails here. See docs/contributing.md.
//
//   E2E_REPOSITORY=owner/sandbox E2E_REVIEWER_TOKEN=... E2E_AUTHOR_TOKEN=... node e2e/sandbox.mts

import type { RestEndpointMethodTypes } from '@octokit/rest'

import { Buffer } from 'node:buffer'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { setTimeout as sleep } from 'node:timers/promises'

import * as core from '@actions/core'
import { Octokit } from '@octokit/rest'

type Pull = RestEndpointMethodTypes['pulls']['get']['response']['data']

const bundlePath = path.resolve(import.meta.dirname, '../dist/index.js')
const prowCommands = '/assign /approve /lgtm /hold'
const holdLabel = 'do-not-merge/hold'

const repository = requireEnv('E2E_REPOSITORY')
const [owner, repo] = repository.split('/')
if (owner === undefined || repo === undefined || repository.split('/').length !== 2) {
  throw new Error(`E2E_REPOSITORY must be owner/repo, got '${repository}'`)
}
const reviewerToken = requireEnv('E2E_REVIEWER_TOKEN')
const reviewer = new Octokit({ auth: reviewerToken })
const author = new Octokit({ auth: requireEnv('E2E_AUTHOR_TOKEN') })
const runId = process.env.E2E_RUN_ID || String(Date.now())
const configSource = `${repository}:.github/prow.yaml`

const branches: string[] = []
const pulls: number[] = []

function requireEnv(name: string): string {
  const value = process.env[name]
  if (value === undefined || value === '') {
    throw new Error(`${name} is not set; see docs/contributing.md#end-to-end-tests`)
  }
  return value
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) {
    throw new Error(`assertion failed: ${message}`)
  }
}

async function step(name: string, fn: () => Promise<void>): Promise<void> {
  core.startGroup(name)
  try {
    await fn()
  }
  finally {
    core.endGroup()
  }
  core.info(`ok - ${name}`)
}

// polls until check returns true; GitHub's reads can trail its writes by a moment
async function waitFor(what: string, check: () => Promise<boolean>, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!(await check())) {
    if (Date.now() > deadline) {
      throw new Error(`timed out after ${timeoutMs / 1000}s waiting for ${what}`)
    }
    await sleep(3000)
  }
}

/**
 * runAction executes dist/index.js the way the runner does: the event as GITHUB_EVENT_PATH,
 * the inputs as INPUT_* variables, api.github.com as the API. The environment is built from
 * scratch so the child never writes to this job's GITHUB_OUTPUT or GITHUB_ENV.
 */
async function runAction(eventName: string, payload: unknown, inputs: Record<string, string> = {}): Promise<number | null> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'prow-e2e-'))
  const eventPath = path.join(tmp, 'event.json')
  fs.writeFileSync(eventPath, JSON.stringify(payload))

  const env: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    HOME: tmp,
    RUNNER_TEMP: tmp,
    GITHUB_EVENT_NAME: eventName,
    GITHUB_EVENT_PATH: eventPath,
    GITHUB_REPOSITORY: repository,
    GITHUB_API_URL: 'https://api.github.com',
    GITHUB_SERVER_URL: 'https://github.com',
    GITHUB_GRAPHQL_URL: 'https://api.github.com/graphql',
    GITHUB_ACTOR: 'prow-e2e',
  }
  for (const [name, value] of Object.entries({ 'github-token': reviewerToken, 'config': configSource, ...inputs }))
    env[`INPUT_${name.toUpperCase()}`] = value

  core.info(`running dist/index.js on ${eventName} (${JSON.stringify(inputs)})`)
  const { promise, resolve, reject } = Promise.withResolvers<number | null>()
  const child = spawn(process.execPath, [bundlePath], { env, stdio: ['ignore', 'inherit', 'inherit'] })
  const timer = setTimeout(() => {
    child.kill('SIGKILL')
    reject(new Error('dist/index.js did not exit within 5 minutes'))
  }, 300_000)
  child.on('error', reject)
  child.on('close', resolve)
  try {
    return await promise
  }
  finally {
    clearTimeout(timer)
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

/**
 * comment posts body on the pull request as client and runs the action on the issue_comment
 * event GitHub delivers for it, built from the real issue and comment.
 */
async function comment(client: Octokit, number: number, body: string): Promise<number | null> {
  const { data: created } = await client.issues.createComment({ owner, repo, issue_number: number, body })
  const { data: issue } = await client.issues.get({ owner, repo, issue_number: number })
  const { data: repoData } = await client.repos.get({ owner, repo })
  core.info(`${created.user?.login} commented '${body}' on #${number}`)
  return runAction('issue_comment', { action: 'created', issue, comment: created, repository: repoData, sender: created.user }, { 'prow-commands': prowCommands })
}

function expectExit(code: number | null, expected: 'success' | 'failure'): void {
  assert((code === 0) === (expected === 'success'), `dist/index.js exited ${code}, expected ${expected}`)
}

async function getPull(number: number): Promise<Pull> {
  return (await reviewer.pulls.get({ owner, repo, pull_number: number })).data
}

async function expectLabel(number: number, label: string, present: boolean): Promise<void> {
  await waitFor(`${label} to be ${present ? 'on' : 'off'} #${number}`, async () => (await getPull(number)).labels.some(l => l.name === label) === present, 15_000)
}

async function expectMerged(number: number): Promise<void> {
  await waitFor(`#${number} to be merged`, async () => (await getPull(number)).merged, 30_000)
}

async function ensureFile(filePath: string, content: string): Promise<void> {
  let sha: string | undefined
  try {
    const { data } = await reviewer.repos.getContent({ owner, repo, path: filePath })
    if (Array.isArray(data) || data.type !== 'file') {
      throw new Error(`${repository}:${filePath} is not a file`)
    }
    if (Buffer.from(data.content, 'base64').toString() === content) {
      return
    }
    sha = data.sha
  }
  catch (e) {
    if ((e as { status?: number }).status !== 404) {
      throw e
    }
  }
  await reviewer.repos.createOrUpdateFileContents({
    owner,
    repo,
    path: filePath,
    message: `e2e: provision ${filePath}`,
    content: Buffer.from(content).toString('base64'),
    ...(sha === undefined ? {} : { sha }),
  })
  core.info(`wrote ${repository}:${filePath}`)
}

// opens a one-file pull request as the author and waits for GitHub to compute its mergeability
async function openPull(name: string): Promise<Pull> {
  const { data: repoData } = await author.repos.get({ owner, repo })
  const base = repoData.default_branch
  const { data: ref } = await author.git.getRef({ owner, repo, ref: `heads/${base}` })
  const branch = `e2e/${runId}-${name}`
  await author.git.createRef({ owner, repo, ref: `refs/heads/${branch}`, sha: ref.object.sha })
  branches.push(branch)
  await author.repos.createOrUpdateFileContents({
    owner,
    repo,
    branch,
    path: `e2e/${runId}-${name}.md`,
    message: `e2e: ${name}`,
    content: Buffer.from(`End-to-end run ${runId}, scenario ${name}.\n`).toString('base64'),
  })
  const { data: pr } = await author.pulls.create({
    owner,
    repo,
    head: branch,
    base,
    title: `e2e ${runId}: ${name}`,
    body: 'Opened by the prow-github-actions end-to-end run; it is merged or closed by the same run.',
  })
  pulls.push(pr.number)
  core.info(`opened #${pr.number} (${branch})`)
  await waitFor(`the mergeability of #${pr.number}`, async () => (await getPull(pr.number)).mergeable !== null)
  return getPull(pr.number)
}

async function cleanup(): Promise<void> {
  for (const number of pulls) {
    try {
      const pr = await getPull(number)
      if (pr.state === 'open') {
        await reviewer.pulls.update({ owner, repo, pull_number: number, state: 'closed' })
        core.info(`closed #${number}`)
      }
    }
    catch (e) {
      core.warning(`could not close #${number}: ${e}`)
    }
  }
  for (const branch of branches) {
    try {
      await reviewer.git.deleteRef({ owner, repo, ref: `heads/${branch}` })
    }
    catch (e) {
      // 422: already gone (auto-deleted on merge)
      if ((e as { status?: number }).status !== 422) {
        core.warning(`could not delete ${branch}: ${e}`)
      }
    }
  }
}

async function main(): Promise<void> {
  assert(fs.existsSync(bundlePath), `${bundlePath} is missing; run npm run pack`)

  let reviewerLogin = ''
  let authorLogin = ''

  await step('identities', async () => {
    reviewerLogin = (await reviewer.users.getAuthenticated()).data.login
    authorLogin = (await author.users.getAuthenticated()).data.login
    // Prow never lets the author /lgtm their own pull request, so the scenario needs two accounts
    assert(reviewerLogin.toLowerCase() !== authorLogin.toLowerCase(), `E2E_REVIEWER_TOKEN and E2E_AUTHOR_TOKEN both belong to ${reviewerLogin}`)
    const { data: permission } = await reviewer.repos.getCollaboratorPermissionLevel({ owner, repo, username: reviewerLogin })
    assert(['admin', 'write'].includes(permission.permission), `${reviewerLogin} needs write access to ${repository}, has ${permission.permission}`)
    core.info(`reviewer ${reviewerLogin}, author ${authorLogin}`)
  })

  await step('provision OWNERS, prow.yaml and labels', async () => {
    await ensureFile('OWNERS', `approvers:\n  - ${reviewerLogin}\nreviewers:\n  - ${reviewerLogin}\n`)
    await ensureFile('.github/prow.yaml', '# managed by the prow-github-actions end-to-end run\nlgtm:\n  bind_to_commit: true\n')
    expectExit(await runAction('workflow_dispatch', { inputs: {}, ref: 'refs/heads/main' }, { jobs: 'label-sync' }), 'success')
    const { data: labels } = await reviewer.issues.listLabelsForRepo({ owner, repo, per_page: 100 })
    for (const name of ['lgtm', 'approved', holdLabel]) {
      assert(labels.some(label => label.name === name), `label-sync did not create ${name}`)
    }
  })

  const merging = await openPull('event-merge')

  await step('the author cannot /lgtm their own pull request', async () => {
    expectExit(await comment(author, merging.number, '/lgtm'), 'failure')
    await expectLabel(merging.number, 'lgtm', false)
  })

  await step('/assign assigns the commenter', async () => {
    expectExit(await comment(reviewer, merging.number, '/assign'), 'success')
    await waitFor(`${reviewerLogin} to be assigned to #${merging.number}`, async () => (await getPull(merging.number)).assignees?.some(a => a.login === reviewerLogin) === true, 15_000)
  })

  await step('/approve by an OWNERS approver applies approved', async () => {
    expectExit(await comment(reviewer, merging.number, '/approve'), 'success')
    await expectLabel(merging.number, 'approved', true)
    assert(!(await getPull(merging.number)).merged, `#${merging.number} merged without lgtm`)
  })

  await step('/lgtm binds lgtm to the head and merges on the comment event', async () => {
    expectExit(await comment(reviewer, merging.number, '/lgtm'), 'success')
    await expectMerged(merging.number)
    const { data: combined } = await reviewer.repos.getCombinedStatusForRef({ owner, repo, ref: merging.head.sha, per_page: 100 })
    assert(combined.statuses.find(status => status.context === 'prow/lgtm')?.state === 'success', `prow/lgtm is not success on ${merging.head.sha}`)
  })

  const held = await openPull('cron-merge')

  await step('/hold keeps an approved, lgtm pull request open', async () => {
    expectExit(await comment(reviewer, held.number, '/hold'), 'success')
    await expectLabel(held.number, holdLabel, true)
    expectExit(await comment(reviewer, held.number, '/approve'), 'success')
    expectExit(await comment(reviewer, held.number, '/lgtm'), 'success')
    await expectLabel(held.number, 'approved', true)
    await expectLabel(held.number, 'lgtm', true)
    assert((await getPull(held.number)).state === 'open', `held #${held.number} was merged or closed`)
  })

  await step('the lgtm cron job merges once the hold is gone', async () => {
    // removed by hand and no event run: only the schedule can merge it now
    await reviewer.issues.removeLabel({ owner, repo, issue_number: held.number, name: holdLabel })
    await expectLabel(held.number, holdLabel, false)
    expectExit(await runAction('schedule', { schedule: '17 3 * * *' }, { jobs: 'lgtm' }), 'success')
    await expectMerged(held.number)
  })
}

main()
  .then(() => core.info('end-to-end run passed'))
  .catch(e => core.setFailed(e instanceof Error ? e.message : String(e)))
  .finally(cleanup)
