import * as core from '@actions/core'
import * as github from '@actions/github'

import { handleCronJobs } from './cronJobs/handleCronJob'
import { handleIssueComment } from './issueComment/handleIssueComment'
import { handlePullReq } from './pullReq/handlePullReq'

export async function run(): Promise<void> {
  try {
    switch (github.context.eventName) {
      case 'issue_comment':
        await handleIssueComment()
        break

      case 'pull_request':
        await handlePullReq()
        break

      case 'schedule':
        await handleCronJobs()
        break

      default:
        core.error(`${github.context.eventName} not yet supported`)
        break
    }
  }
  catch (error) {
    core.setFailed(error instanceof Error ? error.message : String(error))
  }
}
