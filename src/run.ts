import type { Context } from './utils/context'
import type { EventHandler } from './utils/events'

import { handleCronJobs } from './cronJobs/handleCronJob'
import { handleIssueComment } from './issueComment/handleIssueComment'
import { handleIssues } from './issues/handleIssues'
import { platform } from './platform'
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

export async function run(context: Context = platform().context()): Promise<void> {
  try {
    const handler = Object.hasOwn(eventHandlers, context.eventName) ? eventHandlers[context.eventName] : undefined
    if (!handler) {
      platform().log.error(`${context.eventName} not yet supported`)
      return
    }
    await handler(context)
  }
  catch (error) {
    // every handler folds its rejections into an Error (runEventHandlers, normalizeError, the jobs .catch),
    // and the only throw that reaches this catch from the bundle is a built-in TypeError
    platform().fail(error instanceof Error ? error.message : /* v8 ignore next -- non-Error arm unreachable from dist/index.js; run.test.ts drives it */ String(error))
  }
}
