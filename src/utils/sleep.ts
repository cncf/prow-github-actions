/**
 * sleep resolves after the given delay. It lives in its own module so callers
 * bind to it through an import and tests can replace it with a spy.
 *
 * @param ms - milliseconds to wait
 */
export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}
