import { getCommandArgs, getLineArgs } from '../../src/utils/command'

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
