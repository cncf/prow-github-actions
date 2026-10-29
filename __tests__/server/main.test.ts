import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { main, runCronOnce } from '../../src/server/node'

vi.mock('../../src/server/node', () => ({
  main: vi.fn(() => ({ ready: Promise.resolve(), close: () => {} })),
  runCronOnce: vi.fn(async () => 3),
}))

describe('server entry point', () => {
  const argv = process.argv
  const exitCode = process.exitCode

  beforeEach(() => vi.resetModules())
  afterEach(() => {
    process.argv = argv
    process.exitCode = exitCode
  })

  it('starts the server once, from process.env, when loaded', async () => {
    process.argv = [argv[0]!, argv[1]!]

    await import('../../src/server/main')

    expect(main).toHaveBeenCalledTimes(1)
    expect(main).toHaveBeenCalledWith()
    expect(runCronOnce).not.toHaveBeenCalled()
  })

  it('`cron` runs the scheduled jobs once, from process.env, and exits with their status', async () => {
    process.argv = [argv[0]!, argv[1]!, 'cron']

    await import('../../src/server/main')
    await vi.waitFor(() => expect(process.exitCode).toBe(3))

    expect(runCronOnce).toHaveBeenCalledTimes(1)
    expect(runCronOnce).toHaveBeenCalledWith()
    expect(main).not.toHaveBeenCalled()
  })
})
