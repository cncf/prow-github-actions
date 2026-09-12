import type { LabelValue, ProwConfig } from './config'

import { prefixedLabelCommands, sectionFor } from '../labels/prefixed'

/**
 * Colors and descriptions of the labels the action manages itself. They
 * follow kubernetes/test-infra's label_sync where a label exists there;
 * `hold` mirrors `do-not-merge/hold`.
 */
export const builtinLabelDefaults: Record<string, Omit<LabelValue, 'name'>> = {
  'lgtm': { color: '15dd18', description: '"Looks good to me", indicates that a PR is ready to be merged.' },
  'approved': { color: '0ffa16', description: 'Indicates a PR has been approved by an approver from all required OWNERS files.' },
  'hold': { color: 'e11d21', description: 'Indicates that a PR should not merge because someone has issued a /hold command.' },
  'do-not-merge/hold': { color: 'e11d21', description: 'Indicates that a PR should not merge because someone has issued a /hold command.' },
  'help wanted': { color: '006b75', description: 'Denotes an issue that needs help from a contributor. Must meet "help wanted" guidelines.' },
  'good first issue': { color: '7057ff', description: 'Denotes an issue ready for a new contributor, according to the "help wanted" guidelines.' },
  'lifecycle/frozen': { color: 'd3e2f0', description: 'Indicates that an issue or PR should not be auto-closed due to staleness.' },
  'lifecycle/stale': { color: '795548', description: 'Denotes an issue or PR has remained open with no activity and has become stale.' },
  'lifecycle/rotten': { color: '604460', description: 'Denotes an issue or PR that has aged beyond stale and will be auto-closed.' },
}

const needsLabelColor = 'ededed'

/**
 * desiredLabels lists every label the prow configuration describes, with the
 * color and description the label-sync job should give it: the label
 * sections (prefixed `<key>/<value>`, the `/label` allowlist verbatim), the
 * built-in `/lifecycle`, `/stage` and `/status` values where the yaml has no
 * section, the labels the action's own commands apply, and every
 * `require_matching_label` missing label. Names are unique
 * case-insensitively (first definition wins) and sorted.
 *
 * @param config - the merged prow configuration
 */
export function desiredLabels(config: ProwConfig): LabelValue[] {
  const registryKeys = new Set(prefixedLabelCommands.map(cmd => cmd.allowlistKey))
  const labels: LabelValue[] = []

  for (const cmd of prefixedLabelCommands) {
    const section = sectionFor(config.labels, cmd)
    if (section) {
      labels.push(...section.definitions.map(value => prefixed(cmd.prefix, value)))
    }
  }

  for (const [key, section] of Object.entries(config.labels)) {
    if (!registryKeys.has(key)) {
      labels.push(...section.definitions.map(value => prefixed(key, value)))
    }
  }

  const holdLabels = config.hold.label === undefined ? ['hold'] : ['hold', config.hold.label]
  for (const name of ['lgtm', 'approved', ...holdLabels, 'help wanted', 'good first issue']) {
    labels.push({ name })
  }
  for (const rule of config.require_matching_label) {
    labels.push({ name: rule.missing_label })
  }

  const seen = new Set<string>()
  const unique = labels.filter((label) => {
    const key = label.name.toLowerCase()
    if (seen.has(key)) {
      return false
    }
    seen.add(key)
    return true
  })

  return unique
    .map(withDefaults)
    .sort((a, b) => a.name.localeCompare(b.name))
}

function prefixed(prefix: string, value: LabelValue): LabelValue {
  return prefix === '' ? { ...value } : { ...value, name: `${prefix}/${value.name}` }
}

// the configuration wins over the built-in defaults; a label with neither gets no color
function withDefaults(label: LabelValue): LabelValue {
  const defaults = builtinLabelDefaults[label.name.toLowerCase()]
    ?? (label.name.toLowerCase().startsWith('needs-') ? { color: needsLabelColor } : {})

  const merged: LabelValue = { name: label.name }
  const color = label.color ?? defaults.color
  const description = label.description ?? defaults.description
  if (color !== undefined) {
    merged.color = color.toLowerCase()
  }
  if (description !== undefined) {
    merged.description = description
  }
  return merged
}
