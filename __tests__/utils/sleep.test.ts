import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { sleep } from '../../src/utils/sleep'

describe('sleep', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('does not resolve before the delay has elapsed', async () => {
    let settled = false
    const pending = sleep(5000).then(() => {
      settled = true
    })

    await vi.advanceTimersByTimeAsync(4999)
    expect(settled).toBe(false)

    await vi.advanceTimersByTimeAsync(1)
    await pending
    expect(settled).toBe(true)
  })

  it('resolves with undefined once the delay has elapsed', async () => {
    const pending = sleep(250)
    await vi.advanceTimersByTimeAsync(250)
    await expect(pending).resolves.toBeUndefined()
  })

  it('schedules exactly one timer for the requested duration', () => {
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
    void sleep(1234)
    expect(setTimeoutSpy).toHaveBeenCalledExactlyOnceWith(expect.any(Function), 1234)
  })
})
