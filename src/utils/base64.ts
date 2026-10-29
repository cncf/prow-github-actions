/**
 * decodeContent turns a contents API body into text. GitHub serves file bodies
 * base64 encoded with newlines inserted every 60 characters, which `atob`
 * rejects, so they are stripped first.
 *
 * @param content - the `content` field
 * @param encoding - the `encoding` field; only `base64` is supported
 */
export function decodeContent(content: string, encoding: string): string {
  if (encoding !== 'base64') {
    throw new Error(`unsupported content encoding ${encoding}`)
  }
  const bytes = Uint8Array.from(atob(content.replace(/\s+/g, '')), char => char.charCodeAt(0))
  return new TextDecoder().decode(bytes)
}
