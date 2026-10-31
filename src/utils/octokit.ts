import { Octokit } from '@octokit/rest'

import { platform } from '../platform'

export function newOctokit(token: string): Octokit {
  return new Octokit({
    auth: token,
    baseUrl: platform().apiBaseUrl(),
  })
}

/**
 * The client for the configured token, built once per run: every handler of an event shares it.
 */
export function newOctokitFromInputs(): Octokit {
  const token = platform().inputs.get('github-token', { required: true })
  const clients = platform().state().clients
  let client = clients.get(token) as Octokit | undefined
  if (client === undefined) {
    client = newOctokit(token)
    clients.set(token, client)
  }
  return client
}
