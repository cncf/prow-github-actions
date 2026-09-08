import type { Context } from '@actions/github/lib/context'
import * as core from '@actions/core'

import * as github from '@actions/github'
import { Octokit } from '@octokit/rest'

import { getCommandArgs } from '../utils/command'
import { addPrefix, getArgumentLabels, labelIssue } from '../utils/labeling'

/**
 * /priority will add a priority/some-priority label
 *
 * @param context - the github actions event context
 */
export async function priority(context: Context = github.context): Promise<void> {
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

  let commentArgs: string[] = getCommandArgs('/priority', commentBody)

  let priorityLabels: string[] = []
  try {
    priorityLabels = await getArgumentLabels(octokit, context, 'priority')
    core.debug(`priority: found labels ${priorityLabels}`)
  }
  catch (e) {
    throw new Error(`could not get labels from yaml: ${e}`)
  }

  commentArgs = commentArgs.filter((e) => {
    return priorityLabels.includes(e)
  })

  commentArgs = addPrefix('priority', commentArgs)

  // no arguments after command provided
  if (commentArgs.length === 0) {
    throw new Error(`area: command args missing from body`)
  }

  await labelIssue(octokit, context, issueNumber, commentArgs)
}
