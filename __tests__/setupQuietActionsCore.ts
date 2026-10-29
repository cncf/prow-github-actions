import * as core from '@actions/core'
import { beforeEach, vi } from 'vitest'

// setup.ts mocks @actions/core with `spy: true`, so the real implementation still runs and
// its output functions write `::debug::`, `::warning::`, `::error::` and `::add-mask::`
// workflow commands straight to process.stdout (bypassing vitest's console capture).
// Under GitHub Actions the runner parses those lines: a green build-test run carried ten
// `failure` and ten `warning` annotations that were test fixtures, `::add-mask::` redacted
// fixture strings from the rest of the log, and `setFailed` set process.exitCode in the
// worker. Keep the spies — tests assert on the calls — but drop the writes. The
// implementation is reinstalled per test because `mockReset: true` restores the originals.
const outputFunctions = [
  'debug',
  'info',
  'warning',
  'error',
  'notice',
  'setFailed',
  'setSecret',
  'setOutput',
  'exportVariable',
  'addPath',
  'saveState',
  'startGroup',
  'endGroup',
  'setCommandEcho',
] as const

beforeEach(() => {
  for (const name of outputFunctions)
    vi.mocked(core[name]).mockImplementation(() => {})
})
