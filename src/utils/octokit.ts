import { Octokit } from '@octokit/rest'

import { platform } from '../platform'

export function newOctokit(token: string): Octokit {
  return new Octokit({
    auth: token,
    baseUrl: platform().apiBaseUrl(),
  })
}

export function newOctokitFromInputs(): Octokit {
  return newOctokit(platform().inputs.get('github-token', { required: true }))
}
