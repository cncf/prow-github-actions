import { describe, expect, it } from 'vitest'

import { commandLines, hasCommand } from '../../src/utils/command'

// Pins the backtick restriction of `fenceOpener` (src/utils/command.ts) to
// backtick fences only: CommonMark forbids a backtick in the info string of a
// ``` fence, but a ~~~ fence may carry one and still opens a code block.
describe('tilde fence with a backtick in its info string', () => {
  it('opens a code block, so a command inside it is not matched', () => {
    const body = '~~~ `code` ~~~\n/approve\n~~~\n/lgtm'

    expect(hasCommand('/approve', body)).toBe(false)
    expect(hasCommand('/lgtm', body)).toBe(true)
    expect(commandLines(body)).toEqual(['/lgtm'])
  })

  it('is still not an opener when the fence character is a backtick', () => {
    const body = '``` `code` ```\n/approve'

    expect(commandLines(body)).toEqual(['``` `code` ```', '/approve'])
  })
})
