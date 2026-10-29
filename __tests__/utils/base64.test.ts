import { Buffer } from 'node:buffer'
import { describe, expect, it } from 'vitest'

import { decodeContent } from '../../src/utils/base64'

describe('decodeContent', () => {
  it('decodes utf-8 text the way the contents api serves it, wrapped every 60 characters', () => {
    const text = 'approvers:\n  - zoë\n  - 李雷\nreviewers:\n  - renée\n'.repeat(3)
    const wrapped = Buffer.from(text).toString('base64').replace(/(.{60})/g, '$1\n')

    expect(decodeContent(wrapped, 'base64')).toBe(text)
  })

  it('decodes an empty file', () => {
    expect(decodeContent('', 'base64')).toBe('')
  })

  it('rejects encodings other than base64', () => {
    expect(() => decodeContent('abc', 'none')).toThrow(/unsupported content encoding none/)
  })
})
