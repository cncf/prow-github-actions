import type { Octokit } from '@octokit/rest'
import type { Context } from './context'
import type { OwnersSet, OwnersTree } from './owners'

import * as core from '@actions/core'

import { effectiveOwners, loadOwnersTree } from './owners'

/** a pull request and the OWNERS covering its changed files; every login is lowercased */
export interface PullRequestOwners {
  number: number
  /** the tip of the base branch the OWNERS were read from */
  baseSha: string
  headSha: string
  author: string
  draft: boolean
  requestedReviewers: string[]
  assignees: string[]
  labels: string[]
  files: string[]
  tree: OwnersTree
  perFile: Map<string, OwnersSet | undefined>
}

const cache = new Map<string, Promise<PullRequestOwners>>()
const tipCache = new Map<string, Promise<string>>()

/**
 * loadPullRequestOwners reads the pull request, its changed files and the
 * OWNERS files of the base branch that cover them. The result is memoized per
 * pull request for the lifetime of the process, so every plugin acting on the
 * same event shares one fetch.
 *
 * @param octokit - a hydrated github client
 * @param context - the github actions event context
 * @param pullNumber - the pull request
 */
export function loadPullRequestOwners(
  octokit: Octokit,
  context: Context,
  pullNumber: number,
): Promise<PullRequestOwners> {
  const key = `${context.repo.owner}/${context.repo.repo}#${pullNumber}`
  let pending = cache.get(key)
  if (pending === undefined) {
    pending = load(octokit, context, pullNumber)
    cache.set(key, pending)
  }
  return pending
}

export function resetPullRequestOwnersCache(): void {
  cache.clear()
  tipCache.clear()
}

async function load(
  octokit: Octokit,
  context: Context,
  pullNumber: number,
): Promise<PullRequestOwners> {
  const { data: pull } = await octokit.pulls.get({
    ...context.repo,
    pull_number: pullNumber,
  })
  const changed = await octokit.paginate(octokit.pulls.listFiles, {
    ...context.repo,
    pull_number: pullNumber,
    per_page: 100,
  })
  const files = [...new Set(changed.flatMap(f =>
    f.previous_filename !== undefined ? [f.filename, f.previous_filename] : [f.filename],
  ))]

  // OWNERS come from the base branch so a PR cannot grant itself approvers: its current tip, not
  // `pull.base.sha`, which GitHub snapshots when the PR last changed. A PR opened before OWNERS
  // files landed would otherwise never see them, while the tide gate, reading the branch, would
  // require `approved` that `/approve` could not grant (cncf/automation#709).
  const baseSha = await baseBranchTip(octokit, context, pull.base.ref).catch((e) => {
    core.warning(`could not read the tip of ${pull.base.ref}; reading OWNERS at ${pull.base.sha}: ${e}`)
    return pull.base.sha
  })
  const tree = await loadOwnersTree(octokit, context, baseSha, files)
  const perFile = new Map(files.map(file => [file, effectiveOwners(file, tree.owners)]))

  return {
    number: pullNumber,
    baseSha,
    headSha: pull.head.sha,
    author: (pull.user?.login ?? '').toLowerCase(),
    draft: pull.draft === true,
    requestedReviewers: (pull.requested_reviewers ?? []).map(user => user.login.toLowerCase()),
    assignees: (pull.assignees ?? []).map(user => user.login.toLowerCase()),
    labels: (pull.labels ?? []).map(label => label.name),
    files,
    tree,
    perFile,
  }
}

// `repos.getBranch` rather than `git.getRef`: same one request and the same sha, without the
// `heads/` namespace that octokit percent-encodes into the path
function baseBranchTip(octokit: Octokit, context: Context, branch: string): Promise<string> {
  const key = `${context.repo.owner}/${context.repo.repo}@${branch}`
  let pending = tipCache.get(key)
  if (pending === undefined) {
    pending = octokit.repos.getBranch({ ...context.repo, branch }).then(response => response.data.commit.sha)
    tipCache.set(key, pending)
  }
  return pending
}
