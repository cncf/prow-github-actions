import { describe, expect, it, vi } from 'vitest'

import { run } from '../src/run'

vi.mock('../src/run', () => ({
  run: vi.fn(() => Promise.resolve()),
}))

describe('main', () => {
  it('invokes run once when the entry point is loaded', async () => {
    await import('../src/main')

    expect(run).toHaveBeenCalledTimes(1)
    expect(run).toHaveBeenCalledWith()
  })
})
