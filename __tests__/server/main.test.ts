import { describe, expect, it, vi } from 'vitest'

import { main } from '../../src/server/node'

vi.mock('../../src/server/node', () => ({
  main: vi.fn(() => ({ ready: Promise.resolve(), close: () => {} })),
}))

describe('server entry point', () => {
  it('starts the server once, from process.env, when loaded', async () => {
    await import('../../src/server/main')

    expect(main).toHaveBeenCalledTimes(1)
    expect(main).toHaveBeenCalledWith()
  })
})
