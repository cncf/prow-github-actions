import type { Context } from './context'
import { platform } from '../platform'

export type EventHandler = (context: Context) => Promise<void>

const readOnlyForkEvents = new Set(['pull_request', 'pull_request_review'])

/**
 * skipReadOnlyForkRun reports, with a notice, whether this run cannot write:
 * GitHub gives `pull_request` and `pull_request_review` runs for a pull
 * request from a fork a read-only GITHUB_TOKEN (`pull_request_target` and
 * same-repository pull requests get a write token). The `sweep` job covers
 * those pull requests instead.
 *
 * @param context - the github context of the current action event
 */
export function skipReadOnlyForkRun(context: Context): boolean {
  if (!readOnlyForkEvents.has(context.eventName)) {
    return false
  }

  const head: unknown = context.payload.pull_request?.head?.repo?.full_name
  const base: unknown = context.payload.repository?.full_name
  if (typeof head !== 'string' || typeof base !== 'string' || head.toLowerCase() === base.toLowerCase()) {
    return false
  }

  platform().log.notice(`fork pull request under ${context.eventName}: the token is read-only; the sweep job handles it`)
  return true
}

/**
 * Runs every registered handler for an event, one after the other in
 * registration order, and fails the run once with the collected rejections.
 * The order matters: a handler that applies a label (approve) must finish
 * before the one that reads the labels (tide).
 *
 * @param event - the github event name
 * @param handlers - the registry to run
 * @param context - the github context of the current action event
 */
export async function runEventHandlers(event: string, handlers: EventHandler[], context: Context): Promise<void> {
  const errors: Error[] = []
  for (const handler of handlers) {
    try {
      await handler(context)
    }
    catch (e: unknown) {
      errors.push(e instanceof Error ? e : new Error(String(e)))
    }
  }

  if (errors.length > 0) {
    platform().fail(`error handling ${event} event: ${errors.map(e => e.message).join('; ')}`)
  }
}
