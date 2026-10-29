import { describe, expect, it } from 'vitest'

// __tests__/setup.ts: a thrown nullish value must not satisfy toThrow, whatever
// the expected message, because chai skips the message comparison for it

/* eslint-disable prefer-promise-reject-errors -- the nullish rejections are the subject */
function throwing(value: unknown): () => void {
  return () => {
    throw value
  }
}

describe('toThrow with a nullish thrown value', () => {
  it('fails the sync form for undefined and null, with or without an expected message', () => {
    for (const value of [undefined, null]) {
      expect(() => expect(throwing(value)).toThrow('some message')).toThrow('expected an error to be thrown')
      expect(() => expect(throwing(value)).toThrow(/some message/)).toThrow('expected an error to be thrown')
      expect(() => expect(throwing(value)).toThrow()).toThrow('expected an error to be thrown')
    }
  })

  it('names the thrown value', () => {
    expect(() => expect(throwing(undefined)).toThrow('x')).toThrow('but undefined was thrown')
    expect(() => expect(throwing(null)).toThrow('x')).toThrow('but null was thrown')
  })

  it('fails the rejects form', async () => {
    await expect(expect(Promise.reject(undefined)).rejects.toThrow('some message')).rejects.toThrow('expected an error to be thrown')
    await expect(expect(Promise.reject(null)).rejects.toThrow()).rejects.toThrow('expected an error to be thrown')
  })

  it('leaves a real error, a thrown string and the negated form as they were', async () => {
    expect(throwing(new Error('some message'))).toThrow('some message')
    expect(throwing(new Error('other'))).not.toThrow('some message')
    expect(throwing('a string')).toThrow('a string')
    expect(() => {}).not.toThrow()
    expect(() => expect(throwing(new Error('other'))).toThrow('some message')).toThrow()
    await expect(Promise.reject(new Error('some message'))).rejects.toThrow('some message')
    // a thrown nullish value still counts as "something was thrown" for the negated form
    expect(() => expect(throwing(undefined)).not.toThrow()).toThrow()
  })
})
