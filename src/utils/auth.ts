import type { Context } from '@actions/github/lib/context'
import type { Octokit } from '@octokit/rest'
import { Buffer } from 'node:buffer'

import * as core from '@actions/core'

import yaml from 'js-yaml'

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
 * When an OWNERS file is present, use it to authorize the action
   otherwise fall back to allowing organization members and collaborators
 * @param role is the role to check
 * @param username is the user to authorize
 */
export async function assertAuthorizedByOwnersOrMembership(
  octokit: Octokit,
  context: Context,
  role: string,
  username: string,
): Promise<void> {
  core.debug('Checking if the user is authorized to interact with prow')
  const owners = await retrieveOwnersFile(octokit, context)

  if (owners !== '') {
    if (!isInOwnersFile(owners, role, username)) {
      throw new Error(
        `${username} is not included in the ${role} role in the OWNERS file`,
      )
    }
  }
  else {
    const isOrgMember = await checkOrgMember(octokit, context, username)
    const isCollaborator = await checkCollaborator(octokit, context, username)

    if (!isOrgMember && !isCollaborator) {
      throw new Error(`${username} is not a org member or collaborator`)
    }
  }
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

/**
 * Determine if the user has the specified role in the OWNERS file.
 * @param ownersContents - the contents of the OWNERS file
 * @param role - the role to check
 * @param username - the user to authorize
 */
function isInOwnersFile(
  ownersContents: string,
  role: string,
  username: string,
): boolean {
  core.debug(`checking if ${username} is in the ${role} in the OWNERS file`)
  const ownersData: any = yaml.load(ownersContents)

  const roleMembers = ownersData[role]
  if ((roleMembers as string[]) !== undefined) {
    return roleMembers.includes(username)
  }

  core.info(`${username} is not in the ${role} role in the OWNERS file`)
  return false
}
