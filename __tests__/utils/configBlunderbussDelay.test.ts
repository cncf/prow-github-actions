import { describe, expect, it, vi } from 'vitest'

import { parseProwConfig } from '../../src/utils/config'
import * as duration from '../../src/utils/duration'

vi.mock('../../src/utils/duration', { spy: true })

describe('normalizeBlunderbuss', () => {
  it('stringifies a non-Error thrown while parsing blunderbuss.delay', () => {
    vi.mocked(duration.parseDuration).mockImplementationOnce(() => {
      throw 'clock skew' // eslint-disable-line no-throw-literal
    })

    expect(() => parseProwConfig('x', 'blunderbuss:\n  delay: 1h\n')).toThrow('x: clock skew')
  })
})
