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

  it('collects arguments from every matching line', () => {
    const body = '/lgtm cancel\nchanged my mind\n/lgtm'

    expect(getCommandArgs('/lgtm', body)).toEqual(['cancel'])
  })

  it('returns no arguments for a bare command', () => {
    expect(getCommandArgs('/lgtm', '/lgtm')).toMatchObject([])
  })
})

describe('repeated command lines', () => {
  it('concatenates arguments in order of appearance', () => {
    const body = '/kind bug\nsome context\n/kind cleanup'

    expect(getCommandArgs('/kind', body)).toEqual(['bug', 'cleanup'])
  })

  it('de-duplicates repeated arguments', () => {
    const body = '/assign @a @b\n/assign b @c\n/assign a'

    expect(getCommandArgs('/assign', body)).toEqual(['a', 'b', 'c'])
  })

  it('does not collect arguments from a longer command sharing the prefix', () => {
    const body = '/kind bug\n/remove-kind cleanup'

    expect(getCommandArgs('/kind', body)).toEqual(['bug'])
    expect(getCommandArgs('/remove-kind', body)).toEqual(['cleanup'])
  })

  it('keeps getLineArgs single valued with the last line winning', () => {
    const body = '/milestone v1.0\n/milestone v2.0'

    expect(getLineArgs('/milestone', body)).toBe('v2.0')
  })
})

// the matcher accepts any whitespace after the command, so the tokenizer must too
describe('whitespace between command and arguments', () => {
  it('splits arguments on a tab', () => {
    expect(hasCommand('/kind', '/kind\tbug')).toBe(true)
    expect(getCommandArgs('/kind', '/kind\tbug')).toEqual(['bug'])
    expect(getCommandArgs('/kind', '/kind\tbug\tcleanup')).toEqual(['bug', 'cleanup'])
  })

  it('does not leak an empty argument for multiple spaces', () => {
    expect(getCommandArgs('/kind', '/kind  bug')).toEqual(['bug'])
    expect(getCommandArgs('/kind', '/kind   bug    cleanup')).toEqual(['bug', 'cleanup'])
  })

  it('tolerates a non-breaking space before the command', () => {
    expect(hasCommand('/kind', '\u00A0/kind bug')).toBe(true)
    expect(getCommandArgs('/kind', '\u00A0/kind bug')).toEqual(['bug'])
  })

  it('splits arguments on a non-breaking space', () => {
    expect(hasCommand('/kind', '/kind\u00A0bug')).toBe(true)
    expect(getCommandArgs('/kind', '/kind\u00A0bug')).toEqual(['bug'])
  })

  it('ignores trailing whitespace on the line', () => {
    expect(getCommandArgs('/kind', '/kind bug   ')).toEqual(['bug'])
    expect(getCommandArgs('/kind', '/kind bug\t')).toEqual(['bug'])
    expect(getCommandArgs('/lgtm', '/lgtm   ')).toEqual([])
  })

  it('handles CRLF endings with tabs and extra spaces', () => {
    const body = '/kind\tbug\r\n/area  important \r\n'

    expect(getCommandArgs('/kind', body)).toEqual(['bug'])
    expect(getCommandArgs('/area', body)).toEqual(['important'])
  })

  it('still strips a leading @ from tab separated arguments', () => {
    expect(getCommandArgs('/assign', '/assign\t@some-user  @other-user')).toEqual(['some-user', 'other-user'])
  })

  it('applies the same tokenization to getLineArgs', () => {
    expect(getLineArgs('/milestone', '/milestone\tv1.2')).toBe('v1.2')
    expect(getLineArgs('/milestone', '\u00A0/milestone v1.2  ')).toBe('v1.2')
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
