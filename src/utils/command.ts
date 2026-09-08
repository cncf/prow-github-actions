/**
 * getLineArgs will return the line entire line associated with a given command
 * Ex return: '/assign some-user some-other-user'
 *
 * @param command - the given command to get arguments for. Ex: '/assign'
 * @param body - the full body of the comment
 */
export function getLineArgs(command: string, body: string): string {
  let toReturn = ''
  const lineArray = splitLines(body)

  for (const iterator of lineArray) {
    if (iterator.includes(command)) {
      toReturn = iterator.replace(`${command} `, '')
    }
  }

  return toReturn
}

/**
 * getCommandArgs will return an array of the arguments associated with a command
 * Ex return: [`some-user', 'some-other-user']
 *
 * @param command - the given command to get arguments for. Ex: '/assign'
 * @param body - the full body of the comment
 */
export function getCommandArgs(command: string, body: string): string[] {
  const toReturn = []
  const lineArray = splitLines(body)
  let bodyArray

  for (const iterator of lineArray) {
    if (iterator.includes(command)) {
      bodyArray = iterator.split(' ')
    }
  }

  if (bodyArray === undefined) {
    throw new Error(`command ${command} missing from body`)
  }

  let i = 0
  while (bodyArray[i] !== command && i < bodyArray.length) {
    i++
  }

  // advance the index to the next as we've found the command
  i++
  while (bodyArray[i] !== '\n' && i < bodyArray.length) {
    toReturn.push(bodyArray[i])
    i++
  }

  return stripAtSign(toReturn)
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
