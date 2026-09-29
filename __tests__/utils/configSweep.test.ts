import { describe, expect, it, vi } from 'vitest'

import { parseProwConfig } from '../../src/utils/config'
import * as duration from '../../src/utils/duration'

vi.mock('../../src/utils/duration', { spy: true })

describe('normalizeSweep', () => {
  it('accepts an empty sweep mapping with no lookback', () => {
    expect(parseProwConfig('x', 'sweep: {}\n')).toEqual({ sweep: {} })
  })

  it('stringifies a non-Error thrown while parsing sweep.lookback', () => {
    vi.mocked(duration.parseDuration).mockImplementationOnce(() => {
      throw 'clock skew' // eslint-disable-line no-throw-literal
    })

    expect(() => parseProwConfig('x', 'sweep:\n  lookback: 1h\n')).toThrow('x: clock skew')
  })
})
