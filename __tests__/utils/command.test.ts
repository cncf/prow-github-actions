import { describe, expect, it } from 'vitest'

import { getCommandArgs, getLineArgs, hasCommand } from '../../src/utils/command'

it('handles comments with multiple lines', () => {
  const body = `Here is something
here's some more
/command arg1 arg2
/another-comment arg3 arg4
invalid`

  let output = getCommandArgs('/command', body)

  expect(output).toMatchObject(['arg1', 'arg2'])

  output = getCommandArgs('/another-comment', body)

  expect(output).toMatchObject(['arg3', 'arg4'])
})

it('handles a comment with CRLF line endings', () => {
  const body = '/kind enhancement\r\n/milestone some title\r\n/area ai'

  expect(getCommandArgs('/kind', body)).toMatchObject(['enhancement'])
  expect(getCommandArgs('/area', body)).toMatchObject(['ai'])
})

it('does not leave a carriage return on a line argument', () => {
  const body = '/milestone some title\r\n/area ai'

  expect(getLineArgs('/milestone', body)).toBe('some title')
})

describe('strips at signs', () => {
  it('first char of argument', () => {
    const body = `/command @user@name @other@username`

    const output = getCommandArgs('/command', body)

    expect(output).toMatchObject(['user@name', 'other@username'])
  })
})

describe('hasCommand', () => {
  it('matches a command at the start of a line', () => {
    expect(hasCommand('/lgtm', '/lgtm')).toBe(true)
    expect(hasCommand('/lgtm', 'looks fine\n/lgtm cancel')).toBe(true)
    expect(hasCommand('/lgtm', '  /lgtm')).toBe(true)
    expect(hasCommand('/lgtm', '\t/lgtm')).toBe(true)
    expect(hasCommand('/lgtm', '/kind bug\r\n/lgtm\r\n')).toBe(true)
  })

  it('does not match a longer command sharing the prefix', () => {
    expect(hasCommand('/lgtm', '/remove-lgtm')).toBe(false)
    expect(hasCommand('/hold', '/remove-hold')).toBe(false)
    expect(hasCommand('/hold', '/holdon')).toBe(false)
    expect(hasCommand('/assign', '/unassign')).toBe(false)
  })

  it('does not match a mention mid-sentence', () => {
    expect(hasCommand('/hold', 'please do not /hold this')).toBe(false)
    expect(hasCommand('/lgtm', 'the /lgtm command adds a label')).toBe(false)
  })

  it('treats regex metacharacters in the command literally', () => {
    expect(hasCommand('/a.b', '/a.b')).toBe(true)
    expect(hasCommand('/a.b', '/axb')).toBe(false)
  })
})

describe('anchored argument parsing', () => {
  it('throws when only a longer command sharing the prefix is present', () => {
    expect(() => getCommandArgs('/lgtm', '/remove-lgtm')).toThrow(
      'command /lgtm missing from body',
    )
  })

  it('throws when the command is only mentioned mid-sentence', () => {
    expect(() => getCommandArgs('/hold', 'please /hold this')).toThrow(
      'command /hold missing from body',
    )
  })

  it('accepts leading whitespace before the command', () => {
    expect(getCommandArgs('/lgtm', '   /lgtm cancel')).toMatchObject(['cancel'])
    expect(getLineArgs('/milestone', '  /milestone v1.2')).toBe('v1.2')
  })

  it('uses the last matching line', () => {
    const body = '/lgtm cancel\nchanged my mind\n/lgtm'

    expect(getCommandArgs('/lgtm', body)).toMatchObject([])
  })

  it('returns no arguments for a bare command', () => {
    expect(getCommandArgs('/lgtm', '/lgtm')).toMatchObject([])
  })
})

describe('getLineArgs', () => {
  it('returns the trimmed text after the command', () => {
    expect(getLineArgs('/milestone', '/milestone v1.2')).toBe('v1.2')
    expect(getLineArgs('/milestone', '/milestone   v1.2  ')).toBe('v1.2')
  })

  it('returns an empty string for a bare command', () => {
    expect(getLineArgs('/milestone', '/milestone')).toBe('')
    expect(getLineArgs('/milestone', '/milestone ')).toBe('')
  })

  it('returns an empty string when the command is absent', () => {
    expect(getLineArgs('/milestone', 'no command here')).toBe('')
    expect(getLineArgs('/milestone', 'set /milestone v1.2 please')).toBe('')
  })
})
