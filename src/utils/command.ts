/**
 * hasCommand reports whether the command starts a line of the body
 * (leading whitespace allowed) so that mentions mid-sentence and
 * longer commands sharing a prefix (/remove-lgtm vs /lgtm) do not match
 *
 * @param command - the command to look for. Ex: '/assign'
 * @param body - the full body of the comment
 */
export function hasCommand(command: string, body: string): boolean {
  return findCommandArgs(command, body).length > 0
}

/**
 * getLineArgs will return the trimmed text following the command on its line.
 * When the command appears on several lines the last one wins, which suits
 * single-valued commands such as /milestone and /retitle
 * Ex return: 'some-user some-other-user'
 *
 * @param command - the given command to get arguments for. Ex: '/assign'
 * @param body - the full body of the comment
 */
export function getLineArgs(command: string, body: string): string {
  return findCommandArgs(command, body).at(-1) ?? ''
}

/**
 * getCommandArgs will return an array of the arguments associated with a command,
 * collected in order from every line that carries it and de-duplicated
 * Ex return: [`some-user', 'some-other-user']
 *
 * @param command - the given command to get arguments for. Ex: '/assign'
 * @param body - the full body of the comment
 */
export function getCommandArgs(command: string, body: string): string[] {
  const rests = findCommandArgs(command, body)

  if (rests.length === 0) {
    throw new Error(`command ${command} missing from body`)
  }

  const args = rests.flatMap(rest => rest.split(/\s+/).filter(Boolean))

  return [...new Set(stripAtSign(args))]
}

/**
 * hasKeyword reports whether a command keyword such as 'cancel' or 'clear'
 * is among the arguments, ignoring case like Prow's (?i) plugin regexes
 *
 * @param args - the arguments returned by getCommandArgs
 * @param keyword - the lowercase keyword to look for
 */
export function hasKeyword(args: string[], keyword: string): boolean {
  return args.some(arg => arg.toLowerCase() === keyword)
}

function findCommandArgs(command: string, body: string): string[] {
  const pattern = commandPattern(command)
  const found: string[] = []

  for (const line of splitLines(body)) {
    const match = pattern.exec(line)
    if (match) {
      found.push((match[1] ?? '').trim())
    }
  }

  return found
}

function commandPattern(command: string): RegExp {
  // escape regex metacharacters so a command is matched literally
  const escaped = command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // group 1 captures the argument remainder so matcher and tokenizer agree on whitespace
  return new RegExp(`^\\s*${escaped}(?:\\s+(.*))?\\s*$`, 'i')
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
