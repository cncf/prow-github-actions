import { describe, expect, it } from 'vitest'

import { commandLines, getCommandArgs, getLineArgs, hasCommand, hasKeyword } from '../../src/utils/command'

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
    expect(hasCommand('/lgtm', 'looks fine\n\t/lgtm')).toBe(true)
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

  it('does not match a command that is a prefix of another word', () => {
    expect(hasCommand('/label', '/labels foo')).toBe(false)
    expect(hasCommand('/label', '/label foo')).toBe(true)
    expect(hasCommand('/kind', '/kind/foo')).toBe(false)
    expect(hasCommand('/kind', '/kind foo')).toBe(true)
  })

  // #66
  it('does not match a command inside a fenced code block', () => {
    const body = 'try this:\n```\n/kind bug\n```\n'

    expect(hasCommand('/kind', body)).toBe(false)
    expect(() => getCommandArgs('/kind', body)).toThrow('command /kind missing from body')
  })
})

describe('code blocks', () => {
  it('ignores a command inside a ``` fence (issue repro)', () => {
    const body = 'try this:\n```\n/kind bug\n```\n'

    expect(hasCommand('/kind', body)).toBe(false)
    expect(getLineArgs('/kind', body)).toBe('')
  })

  it('ignores a command inside a fence with an info string', () => {
    expect(hasCommand('/approve', '```bash\n/approve\n```')).toBe(false)
    expect(hasCommand('/approve', '```  bash  \n/approve\n```')).toBe(false)
  })

  it('ignores a command inside a ~~~ fence', () => {
    expect(hasCommand('/approve', '~~~\n/approve\n~~~')).toBe(false)
    expect(hasCommand('/approve', '~~~~text\n/approve\n~~~~')).toBe(false)
  })

  it('treats a ~~~ inside a ``` block as literal and closes only on ```', () => {
    const body = '```\n~~~\n/approve\n```\n/lgtm'

    expect(hasCommand('/approve', body)).toBe(false)
    expect(hasCommand('/lgtm', body)).toBe(true)
  })

  it('treats a ``` inside a ~~~ block as literal and closes only on ~~~', () => {
    const body = '~~~\n```\n/approve\n~~~\n/lgtm'

    expect(hasCommand('/approve', body)).toBe(false)
    expect(hasCommand('/lgtm', body)).toBe(true)
  })

  it('closes a fence with a longer fence of the same character', () => {
    const body = '```\n/approve\n````\n/lgtm'

    expect(hasCommand('/approve', body)).toBe(false)
    expect(hasCommand('/lgtm', body)).toBe(true)
  })

  it('does not close a fence with a shorter fence', () => {
    const body = '````\n```\n/approve\n```\n/lgtm\n````\n/hold'

    expect(hasCommand('/approve', body)).toBe(false)
    expect(hasCommand('/lgtm', body)).toBe(false)
    expect(hasCommand('/hold', body)).toBe(true)
  })

  it('does not close a fence with a line that has trailing text after the fence', () => {
    const body = '```\n/approve\n``` not a closer\n/lgtm\n```\n/hold'

    expect(hasCommand('/approve', body)).toBe(false)
    expect(hasCommand('/lgtm', body)).toBe(false)
    expect(hasCommand('/hold', body)).toBe(true)
  })

  it('closes a fence followed by trailing whitespace', () => {
    const body = '```\n/approve\n```   \n/lgtm'

    expect(hasCommand('/approve', body)).toBe(false)
    expect(hasCommand('/lgtm', body)).toBe(true)
  })

  it('swallows everything after an unclosed fence', () => {
    const body = 'see:\n```\n/approve\n/lgtm\n/hold'

    expect(hasCommand('/approve', body)).toBe(false)
    expect(hasCommand('/lgtm', body)).toBe(false)
    expect(hasCommand('/hold', body)).toBe(false)
  })

  it('still matches a command after a closed fence', () => {
    const body = '```\necho hi\n```\n/kind bug'

    expect(hasCommand('/kind', body)).toBe(true)
    expect(getCommandArgs('/kind', body)).toEqual(['bug'])
  })

  it('still matches a command before a fence', () => {
    const body = '/kind bug\n```\n/kind cleanup\n```'

    expect(getCommandArgs('/kind', body)).toEqual(['bug'])
  })

  it('collects only arguments outside fences across several blocks', () => {
    const body = '/kind bug\n```\n/kind a\n```\n/kind cleanup\n~~~\n/kind b\n~~~\n/kind docs'

    expect(getCommandArgs('/kind', body)).toEqual(['bug', 'cleanup', 'docs'])
  })

  it('opens a fence indented by up to 3 spaces', () => {
    expect(hasCommand('/approve', ' ```\n/approve\n```')).toBe(false)
    expect(hasCommand('/approve', '   ```\n/approve\n   ```')).toBe(false)
    expect(hasCommand('/approve', '```\n/approve\n   ```\n/lgtm')).toBe(false)
  })

  it('does not treat a backtick fence with a backtick in its info string as an opener', () => {
    // CommonMark: the info string of a backtick fence may not contain a backtick
    const body = '``` `code` ```\n/approve'

    expect(hasCommand('/approve', body)).toBe(true)
  })

  it('ignores a 4-space indented code block after a blank line', () => {
    const body = 'try this:\n\n    /approve\n'

    expect(hasCommand('/approve', body)).toBe(false)
  })

  it('ignores an indented code block at the start of the body', () => {
    expect(hasCommand('/approve', '    /approve')).toBe(false)
    expect(hasCommand('/approve', '        /approve\n    /lgtm')).toBe(false)
  })

  it('ignores a tab-indented code block', () => {
    expect(hasCommand('/approve', 'try this:\n\n\t/approve')).toBe(false)
    expect(hasCommand('/approve', '\t/approve')).toBe(false)
  })

  it('keeps an indented code block going across its own lines', () => {
    const body = '\n    echo hi\n    /approve\n\n/lgtm'

    expect(hasCommand('/approve', body)).toBe(false)
    expect(hasCommand('/lgtm', body)).toBe(true)
  })

  it('ends an indented code block at the first line that is not indented', () => {
    const body = '\n    echo hi\ntext\n    /approve'

    expect(hasCommand('/approve', body)).toBe(true)
  })

  // simplification: a paragraph continuation line is treated as visible text
  it('still matches an indented line directly after a paragraph (no blank line)', () => {
    expect(hasCommand('/approve', 'some text\n    /approve')).toBe(true)
    expect(hasCommand('/approve', 'some text\n\t/approve')).toBe(true)
  })

  // simplification: list continuation is not parsed, consistent with Prow
  it('still matches an indented list continuation line', () => {
    expect(hasCommand('/approve', '- item\n    /approve')).toBe(true)
  })

  it('still matches a line indented by fewer than 4 spaces', () => {
    expect(hasCommand('/approve', '\n   /approve')).toBe(true)
    expect(getCommandArgs('/kind', '\n   /kind bug')).toEqual(['bug'])
  })

  it('does not match inline code', () => {
    expect(hasCommand('/approve', '`/approve`')).toBe(false)
    expect(hasCommand('/approve', 'run `/approve` to approve')).toBe(false)
  })

  it('does not match a blockquote', () => {
    expect(hasCommand('/approve', '> /approve')).toBe(false)
    expect(hasCommand('/approve', '> quoted\n> /approve')).toBe(false)
  })

  it('handles fences in a CRLF body', () => {
    const body = 'try:\r\n```\r\n/kind bug\r\n```\r\n/kind cleanup\r\n'

    expect(hasCommand('/kind', body)).toBe(true)
    expect(getCommandArgs('/kind', body)).toEqual(['cleanup'])
  })

  it('handles an indented block in a CRLF body', () => {
    const body = 'try:\r\n\r\n    /approve\r\n/lgtm'

    expect(hasCommand('/approve', body)).toBe(false)
    expect(hasCommand('/lgtm', body)).toBe(true)
  })

  it('is case-insensitive and whitespace-tolerant inside fences too', () => {
    expect(hasCommand('/lgtm', '```\n  /LGTM  \n```')).toBe(false)
  })

  describe('commandLines', () => {
    it('returns exactly the visible lines with their original content', () => {
      const body = 'intro\n```bash\n/kind bug\n```\n  /approve  \n\n    indented\n~~~\nx\n~~~\ntail'

      expect(commandLines(body)).toEqual(['intro', '  /approve  ', '', 'tail'])
    })

    it('drops fence lines themselves', () => {
      expect(commandLines('```\n```')).toEqual([])
      expect(commandLines('a\n```\n```\nb')).toEqual(['a', 'b'])
    })

    it('returns every line when there is no code', () => {
      expect(commandLines('a\nb\r\nc')).toEqual(['a', 'b', 'c'])
      expect(commandLines('')).toEqual([''])
    })

    it('keeps an unclosed fence out to the end', () => {
      expect(commandLines('a\n```\nb\nc')).toEqual(['a'])
    })
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

describe('case-insensitive matching', () => {
  it('matches a command regardless of case', () => {
    expect(hasCommand('/lgtm', '/LGTM')).toBe(true)
    expect(hasCommand('/lgtm', '/Lgtm cancel')).toBe(true)
    expect(hasCommand('/remove-lgtm', '/Remove-LGTM')).toBe(true)
    expect(hasCommand('/lgtm', '/lgtmx')).toBe(false)
    expect(hasCommand('/lgtm', '/LGTMX')).toBe(false)
  })

  it('keeps the case of the arguments', () => {
    expect(getCommandArgs('/lgtm', '/Lgtm Cancel')).toEqual(['Cancel'])
    expect(getCommandArgs('/kind', '/KIND Bug')).toEqual(['Bug'])
    expect(getLineArgs('/milestone', '/MILESTONE V1.0')).toBe('V1.0')
  })

  it('still refuses a longer command sharing the prefix', () => {
    expect(hasCommand('/lgtm', '/REMOVE-LGTM')).toBe(false)
    expect(() => getCommandArgs('/lgtm', '/REMOVE-LGTM')).toThrow('command /lgtm missing from body')
  })
})

describe('hasKeyword', () => {
  it('matches a keyword regardless of case', () => {
    expect(hasKeyword(['cancel'], 'cancel')).toBe(true)
    expect(hasKeyword(['Cancel'], 'cancel')).toBe(true)
    expect(hasKeyword(['CANCEL'], 'cancel')).toBe(true)
    expect(hasKeyword(['foo', 'NOT-PLANNED'], 'not-planned')).toBe(true)
  })

  it('requires a whole-argument match', () => {
    expect(hasKeyword([], 'cancel')).toBe(false)
    expect(hasKeyword(['cancelled'], 'cancel')).toBe(false)
    expect(hasKeyword(['no-cancel'], 'cancel')).toBe(false)
  })
})
