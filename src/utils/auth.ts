import type { Octokit } from '@octokit/rest'
import type { Context } from './context'
import type { OwnersRole } from './owners'
import { Buffer } from 'node:buffer'

import * as core from '@actions/core'

import { effectiveOwners, loadOwnersTree, parseOwners } from './owners'

function getErrorDetails(error: unknown): { status: unknown, message: string } {
  if (typeof error === 'object' && error !== null) {
    const status = 'status' in error ? error.status : 'unknown'
    const message
      = 'message' in error && typeof error.message === 'string'
        ? error.message
        : String(error)

    return { status, message }
  }

  return {
    status: 'unknown',
    message: String(error),
  }
}

/**
 * checkOrgMember will check to see if the given user is a repo org member
 *
 * @param octokit - a hydrated github client
 * @param context - the github actions event context
 * @param user - the users to check auth on
 */
export async function checkOrgMember(
  octokit: Octokit,
  context: Context,
  user: string,
): Promise<boolean> {
  try {
    if (context.payload.repository === undefined) {
      core.debug(`checkOrgMember error: context payload repository undefined`)
      return false
    }

    await octokit.orgs.checkMembershipForUser({
      org: context.payload.repository.owner.login,
      username: user,
    })

    return true
  }
  catch (e) {
    const { status, message } = getErrorDetails(e)

    if (status === 404 || status === 302) {
      core.debug(`${user} is not an org member: ${message}`)
      return false
    }

    core.warning(
      `encountered unexpected error: status=${status}, message=${message}`,
    )
    return false
  }
}

/**
 * checkCollaborator checks to see if the given user is a repo collaborator
 *
 * @param octokit - a hydrated github client
 * @param context - the github actions event context
 * @param user - the users to check auth on
 */
export async function checkCollaborator(
  octokit: Octokit,
  context: Context,
  user: string,
): Promise<boolean> {
  try {
    await octokit.repos.checkCollaborator({
      ...context.repo,
      username: user,
    })

    return true
  }
  catch (e) {
    const { status, message } = getErrorDetails(e)

    if (status === 404) {
      core.debug(
        `user ${user} is not a collaborator: status=${status}, message=${message}`,
      )
      return false
    }

    core.warning(
      `encountered unexpected error checking collaborator status: status=${status}, message=${message}`,
    )
    return false
  }
}

/**
 * checkIssueComments will check to see if the given user
 * has commented on the given issue
 *
 * @param octokit - a hydrated github client
 * @param context - the github actions event context
 * @param issueNum - the issue or pr number this runtime is associated with
 * @param user - the users to check auth on
 */
export async function checkIssueComments(
  octokit: Octokit,
  context: Context,
  issueNum: number,
  user: string,
): Promise<boolean> {
  try {
    const comments = await octokit.issues.listComments({
      ...context.repo,
      issue_number: issueNum,
    })

    for (const e of comments.data) {
      if (e.user?.login === user) {
        return true
      }
    }

    return false
  }
  catch (e) {
    const { status, message } = getErrorDetails(e)
    core.warning(
      `encountered unexpected error checking issue comments: status=${status}, message=${message}`,
    )
    return false
  }
}

/**
 * getOrgCollabCommentUsers will return an array of users who are org members,
 * repo collaborators, or have commented previously
 *
 * @param octokit - a hydrated github client
 * @param context - the github actions event context
 * @param issueNum - the issue or pr number this runtime is associated with
 * @param args - the users to check auth on
 */
export async function getOrgCollabCommentUsers(
  octokit: Octokit,
  context: Context,
  issueNum: number,
  args: string[],
): Promise<string[]> {
  const toReturn: string[] = []

  try {
    await Promise.all(
      args.map(async (arg) => {
        const isOrgMember = await checkOrgMember(octokit, context, arg)
        const isCollaborator = await checkCollaborator(octokit, context, arg)
        const hasCommented = await checkIssueComments(
          octokit,
          context,
          issueNum,
          arg,
        )

        if (isOrgMember || isCollaborator || hasCommented) {
          toReturn.push(arg)
        }
      }),
    )
  }
  catch (e) {
    throw new Error(`could not get authorized user: ${e}`)
  }

  return toReturn
}

/**
 * checkCommenterAuth will return true
 * if the user is a org member, a collaborator, or has commented previously
 *
 * @param octokit - a hydrated github client
 * @param context - the github actions event context
 * @param issueNum - the issue or pr number this runtime is associated with
 * @param args - the users to check auth on
 */
export async function checkCommenterAuth(
  octokit: Octokit,
  context: Context,
  issueNum: number,
  user: string,
): Promise<boolean> {
  let isOrgMember: boolean = false
  let isCollaborator: boolean = false
  let hasCommented: boolean = false

  try {
    isOrgMember = await checkOrgMember(octokit, context, user)
  }
  catch (e) {
    throw new Error(`error in checking org member: ${e}`)
  }

  try {
    isCollaborator = await checkCollaborator(octokit, context, user)
  }
  catch (e) {
    throw new Error(`could not check collaborator: ${e}`)
  }

  try {
    hasCommented = await checkIssueComments(octokit, context, issueNum, user)
  }
  catch (e) {
    throw new Error(`could not check issue comments: ${e}`)
  }

  if (isOrgMember || isCollaborator || hasCommented) {
    return true
  }

  return false
}

/**
 * When the repository has OWNERS files, use them to authorize the action,
 * otherwise fall back to allowing organization members and collaborators.
 * On a pull request the OWNERS covering each changed file are used
 * (approvers must cover every file, reviewers at least one); on an issue the
 * root OWNERS file is used.
 * @param octokit - a hydrated github client
 * @param context - the github actions event context
 * @param role - the role to check
 * @param username - the user to authorize
 */
export async function assertAuthorizedByOwnersOrMembership(
  octokit: Octokit,
  context: Context,
  role: OwnersRole,
  username: string,
): Promise<void> {
  core.debug('Checking if the user is authorized to interact with prow')

  const hasOwners
    = context.payload.issue?.pull_request !== undefined
      ? await assertPullRequestOwner(octokit, context, role, username)
      : await assertRootOwner(octokit, context, role, username)

  if (!hasOwners) {
    const isOrgMember = await checkOrgMember(octokit, context, username)
    const isCollaborator = await checkCollaborator(octokit, context, username)

    if (!isOrgMember && !isCollaborator) {
      throw new Error(`${username} is not a org member or collaborator`)
    }
  }
}

/**
 * Authorize against the root OWNERS file of the default branch.
 * @returns false when the repository has no root OWNERS file
 */
async function assertRootOwner(
  octokit: Octokit,
  context: Context,
  role: OwnersRole,
  username: string,
): Promise<boolean> {
  const contents = await retrieveOwnersFile(octokit, context)
  if (contents === '') {
    return false
  }

  const owners = parseOwners('OWNERS', contents)
  if (!owners[role].includes(username.toLowerCase())) {
    throw new Error(
      `${username} is not included in the ${role} role in the OWNERS file`,
    )
  }
  return true
}

/**
 * Authorize against the OWNERS files covering the pull request's changed files.
 * @returns false when the repository has no OWNERS files at all
 */
async function assertPullRequestOwner(
  octokit: Octokit,
  context: Context,
  role: OwnersRole,
  username: string,
): Promise<boolean> {
  const pullNumber = context.payload.issue!.number

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

  // OWNERS come from the base branch so a PR cannot grant itself approvers
  const tree = await loadOwnersTree(octokit, context, pull.base.sha, files)
  if (!tree.hasOwners) {
    core.debug('No OWNERS files found')
    return false
  }

  const login = username.toLowerCase()
  const covered = files.map((file) => {
    const owners = effectiveOwners(file, tree.owners)
    if (owners === undefined) {
      throw new Error(`no OWNERS file covers ${file}`)
    }
    return { file, owners }
  })

  if (role === 'approvers') {
    const failing = covered.find(({ owners }) => !owners.approvers.has(login))
    if (failing !== undefined) {
      throw new Error(
        `${username} is not an approver for ${failing.file} (OWNERS: ${failing.owners.sources.join(', ')})`,
      )
    }
  }
  else if (!covered.some(({ owners }) => owners.reviewers.has(login) || owners.approvers.has(login))) {
    throw new Error(
      `${username} is not a reviewer or approver for any changed file`,
    )
  }

  return true
}

/**
 * Retrieve the contents of the OWNERS file at the root of the repository.
 * If the file does not exist, returns an empty string.
 */
async function retrieveOwnersFile(
  octokit: Octokit,
  context: Context,
): Promise<string> {
  core.debug(`Looking for an OWNERS file at the root of the repository`)
  let data: any
  try {
    const response = await octokit.repos.getContent({
      ...context.repo,
      path: 'OWNERS',
    })
    data = response.data
  }
  catch (e) {
    if (typeof e === 'object' && e && 'status' in e && e.status === 404) {
      core.debug('No OWNERS file found')
      return ''
    }

    throw new Error(
      `error checking for an OWNERS file at the root of the repository: ${e}`,
    )
  }

  if (!data.content || !data.encoding) {
    throw new Error(`invalid OWNERS file returned from GitHub API: ${data}`)
  }

  const decoded = Buffer.from(data.content, data.encoding).toString()
  core.debug(`OWNERS file contents: ${decoded}`)
  return decoded
}
