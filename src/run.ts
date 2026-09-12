import type { Context } from './utils/context'
import type { EventHandler } from './utils/events'

import * as core from '@actions/core'
import * as github from '@actions/github'

import { handleCronJobs } from './cronJobs/handleCronJob'
import { handleIssueComment } from './issueComment/handleIssueComment'
import { handleIssues } from './issues/handleIssues'
import { handleCheckSuite } from './pullReq/handleCheckSuite'
import { handlePullReq } from './pullReq/handlePullReq'
import { handlePullReqReview } from './pullReq/handlePullReqReview'

// one row per github event; pull_request_target shares the pull_request payload,
// status is the legacy commit status that check_suite superseded
const eventHandlers: Record<string, EventHandler> = {
  issue_comment: handleIssueComment,
  issues: handleIssues,
  pull_request: handlePullReq,
  pull_request_target: handlePullReq,
  pull_request_review: handlePullReqReview,
  check_suite: handleCheckSuite,
  status: handleCheckSuite,
  schedule: handleCronJobs,
  workflow_dispatch: handleCronJobs,
  push: handleCronJobs,
}

export async function run(): Promise<void> {
  try {
    const context: Context = github.context
    const handler = Object.hasOwn(eventHandlers, context.eventName) ? eventHandlers[context.eventName] : undefined
    if (!handler) {
      core.error(`${context.eventName} not yet supported`)
      return
    }
    await handler(context)
  }
  catch (error) {
    core.setFailed(error instanceof Error ? error.message : String(error))
  }
}
