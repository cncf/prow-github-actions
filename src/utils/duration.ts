const durationUnits: Record<string, number> = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000 }
const durationPart = /(\d+(?:\.\d+)?)(ms|[smh])/gy

/**
 * parseDuration reads a Go style duration such as `5s`, `2m30s` or `500ms`
 * and returns milliseconds; an empty or `0` value is zero.
 *
 * @param text - the configured duration
 * @param field - the configuration field, for the error message
 */
export function parseDuration(text: string | undefined, field = 'grace_period_duration'): number {
  const value = (text ?? '').trim()
  if (value === '' || value === '0') {
    return 0
  }

  let ms = 0
  let consumed = 0
  durationPart.lastIndex = 0
  for (let match = durationPart.exec(value); match !== null; match = durationPart.exec(value)) {
    ms += Number.parseFloat(match[1]) * durationUnits[match[2]]
    consumed = durationPart.lastIndex
  }

  if (consumed !== value.length) {
    throw new Error(`invalid ${field} '${text}': expected a duration such as 5s, 2m or 500ms`)
  }

  return Math.round(ms)
}
