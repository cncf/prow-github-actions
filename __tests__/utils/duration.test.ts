import { describe, expect, it } from 'vitest'

import { parseDuration } from '../../src/utils/duration'

describe('parseDuration', () => {
  it.each([
    [' 5s', 5000],
    ['5s ', 5000],
    ['\t2m\n', 120_000],
    [' 0 ', 0],
    ['   ', 0],
  ])('trims surrounding whitespace: %j -> %d ms', (text, ms) => {
    expect(parseDuration(text)).toBe(ms)
  })

  it.each([
    ['1.5ms', 2],
    ['2.25ms', 2],
    ['0.0015s', 2],
  ])('rounds a fractional result to whole milliseconds: %s -> %d ms', (text, ms) => {
    expect(parseDuration(text)).toBe(ms)
  })

  it('names the field in the error', () => {
    expect(() => parseDuration('soon', 'delay')).toThrow(`invalid delay 'soon'`)
  })
})
