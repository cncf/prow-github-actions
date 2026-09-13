/**
 * matchesLabelPattern reports whether a label name matches a tide label
 * pattern. Names compare case-insensitively, like GitHub does. `*` matches any
 * run of characters, `/` included, so `do-not-merge/*` covers the whole
 * family; everything else is literal (`do-not-merge` alone does not match
 * `do-not-merge/hold`).
 *
 * @param pattern - a label name, optionally with `*` wildcards
 * @param label - the label name to test
 */
export function matchesLabelPattern(pattern: string, label: string): boolean {
  const parts = pattern.toLowerCase().split('*')
  const subject = label.toLowerCase()

  if (parts.length === 1) {
    return subject === parts[0]
  }

  if (!subject.startsWith(parts[0])) {
    return false
  }
  const last = parts[parts.length - 1]
  if (!subject.endsWith(last) || subject.length < parts[0].length + last.length) {
    return false
  }

  // the middle parts must appear in order between the anchored ends
  let at = parts[0].length
  const end = subject.length - last.length
  for (const part of parts.slice(1, -1)) {
    const found = subject.indexOf(part, at)
    if (found === -1 || found + part.length > end) {
      return false
    }
    at = found + part.length
  }
  return true
}

/**
 * anyLabelMatches reports whether any of the patterns matches any of the labels
 *
 * @param patterns - label patterns, see matchesLabelPattern
 * @param labels - the label names to test
 */
export function anyLabelMatches(patterns: string[], labels: string[]): boolean {
  return patterns.some(pattern => labels.some(label => matchesLabelPattern(pattern, label)))
}
