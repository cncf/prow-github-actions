import process from 'node:process'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { newOctokit } from '../../src/utils/octokit'

describe('newOctokit', () => {
  let saved: string | undefined

  beforeEach(() => {
    saved = process.env.GITHUB_API_URL
    delete process.env.GITHUB_API_URL
  })

  afterEach(() => {
    if (saved === undefined)
      delete process.env.GITHUB_API_URL
    else
      process.env.GITHUB_API_URL = saved
  })

  it('defaults to api.github.com when GITHUB_API_URL is unset', () => {
    const octokit = newOctokit('some-token')
    expect(octokit.request.endpoint.DEFAULTS.baseUrl).toBe('https://api.github.com')
  })

  it('honours GITHUB_API_URL for GitHub Enterprise Server', () => {
    process.env.GITHUB_API_URL = 'https://ghes.example.com/api/v3'
    const octokit = newOctokit('some-token')
    expect(octokit.request.endpoint.DEFAULTS.baseUrl).toBe('https://ghes.example.com/api/v3')
  })

  it('treats an empty GITHUB_API_URL as unset', () => {
    process.env.GITHUB_API_URL = ''
    const octokit = newOctokit('some-token')
    expect(octokit.request.endpoint.DEFAULTS.baseUrl).toBe('https://api.github.com')
  })
})
