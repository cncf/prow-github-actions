import type { Context } from './context'

import * as core from '@actions/core'

export type EventHandler = (context: Context) => Promise<void>

/**
 * Runs every registered handler for an event, one after the other in
 * registration order, and fails the run once with the collected rejections.
 * The order matters: a handler that applies a label (approve) must finish
 * before the one that reads the labels (tide). An empty registry is a
 * debug-logged no-op.
 *
 * @param event - the github event name
 * @param handlers - the registry to run
 * @param context - the github context of the current action event
 */
export async function runEventHandlers(event: string, handlers: EventHandler[], context: Context): Promise<void> {
  const action: string | undefined = context.payload.action

  if (handlers.length === 0) {
    core.debug(`${event} event ${action} received; no handlers registered yet`)
    return
  }

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
    core.setFailed(`error handling ${event} event: ${errors.map(e => e.message).join('; ')}`)
  }
}
