/**
 * hasCommand reports whether the command starts a line of the body
 * (leading whitespace allowed) so that mentions mid-sentence and
 * longer commands sharing a prefix (/remove-lgtm vs /lgtm) do not match
 *
 * @param command - the command to look for. Ex: '/assign'
 * @param body - the full body of the comment
 */
export function hasCommand(command: string, body: string): boolean {
  return findCommandLine(command, body) !== undefined
}

/**
 * getLineArgs will return the trimmed text following the command on its line
 * Ex return: 'some-user some-other-user'
 *
 * @param command - the given command to get arguments for. Ex: '/assign'
 * @param body - the full body of the comment
 */
export function getLineArgs(command: string, body: string): string {
  const line = findCommandLine(command, body)
  if (line === undefined) {
    return ''
  }

  return line.trim().slice(command.length).trim()
}

/**
 * getCommandArgs will return an array of the arguments associated with a command
 * Ex return: [`some-user', 'some-other-user']
 *
 * @param command - the given command to get arguments for. Ex: '/assign'
 * @param body - the full body of the comment
 */
export function getCommandArgs(command: string, body: string): string[] {
  const line = findCommandLine(command, body)

  if (line === undefined) {
    throw new Error(`command ${command} missing from body`)
  }

  const args = line.trim().split(' ').slice(1)

  return stripAtSign(args)
}

function findCommandLine(command: string, body: string): string | undefined {
  const pattern = commandPattern(command)
  let found: string | undefined

  for (const line of splitLines(body)) {
    if (pattern.test(line)) {
      found = line
    }
  }

  return found
}

function commandPattern(command: string): RegExp {
  // escape regex metacharacters so a command is matched literally
  const escaped = command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return new RegExp(`^\\s*${escaped}(\\s|$)`)
}

// splitLines splits a comment body into lines, tolerating CRLF and CR endings
function splitLines(body: string): string[] {
  return body.replace(/\r\n?/g, '\n').split('\n')
}

/**
 * stripAtSign will remove a leading '@' sign from the arguments array
 * This is necessary as some commands may have arguments with users tagged with
 * a leading at sign. Ex: /assign @some-user
 *
 * @param args - the array to remove at signs from
 */
function stripAtSign(args: string[]): string[] {
  const toReturn: string[] = []

  for (const e of args) {
    if (e.startsWith('@')) {
      toReturn.push(e.replace('@', ''))
    }
    else {
      toReturn.push(e)
    }
  }

  return toReturn
}
