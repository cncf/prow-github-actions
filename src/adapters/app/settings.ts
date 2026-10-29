import type { InputName } from '../../platform'

/**
 * AppSettings carries the App deployment's configuration. The six input names
 * mirror action.yml; github-token is not among them because the adapter mints
 * an installation token per event.
 */
export interface AppSettings {
  appId: string
  privateKey: string
  webhookSecret: string
  apiBaseUrl: string
  inputs: Partial<Record<Exclude<InputName, 'github-token'>, string>>
}

const inputEnv: Record<Exclude<InputName, 'github-token'>, string> = {
  'prow-commands': 'PROW_COMMANDS',
  'jobs': 'PROW_JOBS',
  'merge-method': 'PROW_MERGE_METHOD',
  'config': 'PROW_CONFIG',
  'dry-run': 'PROW_DRY_RUN',
  'cat-api-key': 'CAT_API_KEY',
}

function required(env: Record<string, string | undefined>, name: string): string {
  const value = env[name]
  if (!value) {
    throw new Error(`${name} must be set`)
  }
  return value
}

/**
 * normalizePrivateKey accepts the key as GitHub serves it or as a deployment
 * stores it: a single-line variable arrives with literal \n. On Node either
 * PKCS#1 (`BEGIN RSA PRIVATE KEY`) or PKCS#8 (`BEGIN PRIVATE KEY`) signs; on
 * Workers only PKCS#8 does, which docs/github-app.md explains how to produce.
 */
export function normalizePrivateKey(key: string): string {
  return key.replace(/\\n/g, '\n').trim()
}

export function settingsFromEnv(env: Record<string, string | undefined>): AppSettings {
  // the scheduler runs the merger unless told otherwise, as the reusable workflow does
  const inputs: AppSettings['inputs'] = { jobs: 'lgtm' }
  for (const [input, variable] of Object.entries(inputEnv) as [Exclude<InputName, 'github-token'>, string][]) {
    const value = env[variable]
    if (value !== undefined) {
      inputs[input] = value
    }
  }
  return {
    appId: required(env, 'GITHUB_APP_ID'),
    privateKey: normalizePrivateKey(required(env, 'GITHUB_APP_PRIVATE_KEY')),
    webhookSecret: required(env, 'GITHUB_WEBHOOK_SECRET'),
    apiBaseUrl: env.GITHUB_API_URL || 'https://api.github.com',
    inputs,
  }
}
