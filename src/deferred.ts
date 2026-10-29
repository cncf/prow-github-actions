import type { Deferred } from './platform'

import { resumeRequiredLabels } from './plugins/requireMatchingLabel'

/**
 * resumeDeferred runs the work a platform put off with defer(). It is the
 * entry point a queue consumer or alarm calls, under the deferred event's
 * platform.
 *
 * @param deferred - what defer() was given
 */
export async function resumeDeferred(deferred: Deferred): Promise<void> {
  switch (deferred.kind) {
    case 'require-matching-label':
      return resumeRequiredLabels(deferred.context)
  }
}
