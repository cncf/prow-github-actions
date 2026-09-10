import type { Octokit } from '@octokit/rest'
import type { Context } from './context'

/**
 * createComment comments on the specified issue or pull request
 *
 * @param octokit - a hydrated github client
 * @param context - the github actions event context
 * @param issueNum - the issue associated with this runtime
 * @param message - the comment message body
 */
export async function createComment(
  octokit: Octokit,
  context: Context,
  issueNum: number,
  message: string,
): Promise<void> {
  try {
    await octokit.issues.createComment({
      ...context.repo,
      issue_number: issueNum,
      body: message,
    })
  }
  catch (e) {
    throw new Error(`could not add comment: ${e}`)
  }
}
