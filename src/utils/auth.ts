import type { Octokit } from '@octokit/rest'
import type { AuthorizationPolicy, ResolvedAuthorization } from './config'
import type { Context } from './context'
import type { OwnersRole } from './owners'
import { Buffer } from 'node:buffer'

import * as core from '@actions/core'

import { defaultAuthorization, loadProwConfig, resolveAuthorization } from './config'
import { parseOwners } from './owners'
import { loadPullRequestOwners } from './pullRequestOwners'

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
 * On a pull request the OWNERS covering each changed file are used: the user
 * must hold the role for at least one changed file (an approver's /approve
 * then counts for the files they cover; the approve plugin decides whether the
 * whole PR is approved). On an issue the root OWNERS file is used.
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
      // every review policy admits members and collaborators, so only a refusal needs the configuration
      const { review, users } = await loadAuthorization(octokit, context).catch(() => defaultAuthorization)
      if (review === 'members') {
        throw new Error(`${username} is not a org member or collaborator`)
      }
      if (!users.includes(username.toLowerCase())) {
        throw new Error(`${username} is not a org member, collaborator or listed in authorization.users`)
      }
    }
  }
}

/** checks the caller already ran that refused the user, so policyAllows does not repeat them */
export interface RefusedChecks {
  member?: boolean
  collaborator?: boolean
}

/**
 * policyAllows reports whether an `authorization` policy admits the user,
 * cheapest check first: `anyone` makes no API call; `trusted` tries
 * `users`, then org membership, then the collaborator check, then the root
 * OWNERS file of the default branch (reviewers and approvers alike).
 *
 * @param octokit - a hydrated github client
 * @param context - the github actions event context
 * @param policy - the policy to apply
 * @param user - the user to authorize
 * @param users - the lower-cased `authorization.users`
 * @param refused - checks that already refused the user and are skipped
 */
export async function policyAllows(
  octokit: Octokit,
  context: Context,
  policy: AuthorizationPolicy,
  user: string,
  users: string[],
  refused: RefusedChecks = {},
): Promise<boolean> {
  if (!user) {
    return false
  }
  if (policy === 'anyone') {
    return true
  }
  if (policy === 'trusted' && users.includes(user.toLowerCase())) {
    return true
  }
  if (policy !== 'collaborators' && refused.member !== true && await checkOrgMember(octokit, context, user)) {
    return true
  }
  if (refused.collaborator !== true && await checkCollaborator(octokit, context, user)) {
    return true
  }
  return policy === 'trusted' && rootOwnersIncludes(octokit, context, user)
}

/**
 * assertPolicy throws unless the `authorization.<key>` policy admits the user.
 *
 * @param octokit - a hydrated github client
 * @param context - the github actions event context
 * @param auth - the resolved authorization section
 * @param key - the policy to apply
 * @param user - the user to authorize
 * @param command - the command the user ran, for the error message
 */
export async function assertPolicy(
  octokit: Octokit,
  context: Context,
  auth: ResolvedAuthorization,
  key: 'labels' | 'hold' | 'close',
  user: string,
  command: string,
): Promise<void> {
  if (!await policyAllows(octokit, context, auth[key], user, auth.users)) {
    throw new Error(`${user} is not authorized to run ${command}: authorization.${key} is ${auth[key]}`)
  }
}

/**
 * closePolicyAllows decides /close and /reopen for a user who is neither the
 * author nor a collaborator: every `close` policy admits collaborators, so
 * the configuration is read only on this path, and the collaborator check
 * is not repeated. A configuration that cannot be loaded refuses, with a
 * warning, so the refusal stays silent.
 *
 * @param octokit - a hydrated github client
 * @param context - the github actions event context
 * @param user - the user the collaborator check refused
 */
export async function closePolicyAllows(
  octokit: Octokit,
  context: Context,
  user: string,
): Promise<boolean> {
  let auth: ResolvedAuthorization
  try {
    auth = await loadAuthorization(octokit, context)
  }
  catch {
    return false
  }
  return policyAllows(octokit, context, auth.close, user, auth.users, { collaborator: true })
}

// a configuration that cannot be loaded admits nobody new: the caller falls back to today's gate, and the
// error goes to the log only, never into a public refusal comment
async function loadAuthorization(octokit: Octokit, context: Context): Promise<ResolvedAuthorization> {
  try {
    return resolveAuthorization((await loadProwConfig(octokit, context)).authorization)
  }
  catch (e) {
    core.warning(`authorization: could not load prow config: ${e}`)
    throw e
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
  const { files, tree, perFile } = await loadPullRequestOwners(octokit, context, context.payload.issue!.number)
  if (!tree.hasOwners) {
    core.debug('No OWNERS files found')
    return false
  }

  const login = username.toLowerCase()
  const covered = files.map((file) => {
    const owners = perFile.get(file)
    if (owners === undefined) {
      throw new Error(`no OWNERS file covers ${file}`)
    }
    return { file, owners }
  })

  if (role === 'approvers') {
    if (!covered.some(({ owners }) => owners.approvers.has(login))) {
      throw new Error(`${username} is not an approver for any changed file`)
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
 * Whether the root OWNERS file of the default branch lists the user as a
 * reviewer or an approver.
 * @returns false when the repository has no root OWNERS file
 */
async function rootOwnersIncludes(
  octokit: Octokit,
  context: Context,
  user: string,
): Promise<boolean> {
  const contents = await retrieveOwnersFile(octokit, context)
  if (contents === '') {
    return false
  }

  const owners = parseOwners('OWNERS', contents)
  const login = user.toLowerCase()
  return owners.reviewers.includes(login) || owners.approvers.includes(login)
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
