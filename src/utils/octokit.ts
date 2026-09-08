import process from 'node:process'
import { Octokit } from '@octokit/rest'

// GITHUB_API_URL is set by the runner and differs on GitHub Enterprise Server
export function newOctokit(token: string): Octokit {
  return new Octokit({
    auth: token,
    baseUrl: process.env.GITHUB_API_URL || 'https://api.github.com',
  })
}
