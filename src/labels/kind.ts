import type { Context } from '@actions/github/lib/context'
import * as core from '@actions/core'

import * as github from '@actions/github'
import { Octokit } from '@octokit/rest'

import { getCommandArgs } from '../utils/command'
import { addPrefix, getArgumentLabels, labelIssue } from '../utils/labeling'

/**
 * /kind will add a kind/some-kind label
 *
 * @param context - the github actions event context
 */
export async function kind(context: Context = github.context): Promise<void> {
  const token = core.getInput('github-token', { required: true })
  const octokit = new Octokit({
    auth: token,
  })

  const issueNumber: number | undefined = context.payload.issue?.number
  const commentBody: string = context.payload.comment?.body

  if (issueNumber === undefined) {
    throw new Error(
      `github context payload missing issue number: ${context.payload}`,
    )
  }

  let commentArgs: string[] = getCommandArgs('/kind', commentBody)

  let kindLabels: string[] = []
  try {
    kindLabels = await getArgumentLabels(octokit, context, 'kind')
    core.debug(`kind: found labels ${kindLabels}`)
  }
  catch (e) {
    throw new Error(`could not get labels from yaml: ${e}`)
  }

  commentArgs = commentArgs.filter((e) => {
    return kindLabels.includes(e)
  })

  commentArgs = addPrefix('kind', commentArgs)

  // no arguments after command provided
  if (commentArgs.length === 0) {
    throw new Error(`area: command args missing from body`)
  }

  await labelIssue(octokit, context, issueNumber, commentArgs)
}
