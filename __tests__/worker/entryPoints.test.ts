import { readdirSync, readFileSync } from 'node:fs'
import * as path from 'node:path'

import { describe, expect, it } from 'vitest'
import { root } from '../utils/workflowYaml'

// src/server/worker.ts runs only inside workerd (worker.test.ts, via miniflare), where
// neither coverage run reaches: vitest.config.mjs excludes the file from the unit run on
// the promise that "its behaviour is tested there", and the bundle run leaves src/server
// out. So nothing numeric notices when an entry point of the Worker — a handler of its
// default export, a Hono route, a top-level function — gains no test, which is how
// scheduled(), queue() and deferViaQueue shipped untested (#629). This file pins the part
// of that promise that can be checked statically: every entry point worker.ts declares is
// listed below with the evidence that drives it, and that evidence is present in the
// worker suite. A new entry point fails here until it is listed; a deleted driver fails
// here until the entry point is driven again.

const workerSource = readFileSync(path.join(root, 'src/server/worker.ts'), 'utf8')
const workerTestsDir = path.join(root, '__tests__/worker')
const workerTests = readdirSync(workerTestsDir)
  .filter(name => name.endsWith('.test.ts') && name !== path.basename(__filename))
  .map(name => readFileSync(path.join(workerTestsDir, name), 'utf8'))
  .join('\n')

/**
 * What in the worker suite drives each entry point. The value is text that must
 * appear in a `__tests__/worker/*.test.ts` file: the request, trigger or
 * scenario through which the suite reaches the entry point inside workerd.
 */
const drivers: Record<string, string> = {
  // the default export's handlers (ExportedHandler)
  'fetch': 'dispatchFetch(\'https://prow.test/webhook\'',
  'scheduled': '/cdn-cgi/handler/scheduled',
  'queue': 'is retried, not acknowledged',
  // Hono routes
  'GET /healthz': '/healthz',
  'POST /webhook': 'dispatchFetch(\'https://prow.test/webhook\'',
  // top-level functions and classes
  'kvDeliveryStore': 'redelivered',
  'PullRequestLock': 'through the pull request lock',
  'emit': 'is retried, not acknowledged',
  'sinkFor': 'dispatchFetch(\'https://prow.test/webhook\'',
  'deferViaQueue': 'grace_period_duration',
  'handleDelivery': 'dispatchFetch(\'https://prow.test/webhook\'',
  'receiverFor': 'dispatchFetch(\'https://prow.test/webhook\'',
  'tokensFor': 'mints an installation token once per isolate',
}

function entryPointsOf(source: string): string[] {
  const found: string[] = []
  const defaultExport = source.slice(source.indexOf('\nexport default {'))
  for (const match of defaultExport.matchAll(/^ {2}(?:async )?(\w+)\s*[(:]/gm)) {
    found.push(match[1])
  }
  for (const match of source.matchAll(/^app\.(get|post|put|patch|delete)\('([^']+)'/gm)) {
    found.push(`${match[1].toUpperCase()} ${match[2]}`)
  }
  for (const match of source.matchAll(/^(?:export )?(?:async )?function (\w+)|^export class (\w+)|^const (\w+) = \(/gm)) {
    found.push(match[1] ?? match[2] ?? match[3])
  }
  return found
}

describe('src/server/worker.ts entry points', () => {
  const entryPoints = entryPointsOf(workerSource)

  it('finds the handlers, routes and functions the file declares', () => {
    expect(entryPoints).toEqual(expect.arrayContaining(['fetch', 'scheduled', 'queue', 'POST /webhook', 'deferViaQueue']))
  })

  it('lists every entry point with the test that drives it, and no other', () => {
    expect(Object.keys(drivers).sort()).toEqual([...new Set(entryPoints)].sort())
  })

  it.each(Object.entries(drivers))('%s is driven by the worker suite (%s)', (_entryPoint, evidence) => {
    expect(workerTests).toContain(evidence)
  })
})
