import * as core from '@actions/core'

import { checkCollaborator, checkIssueComments, checkOrgMember } from '../../src/utils/auth'

describe('auth utils', () => {
  afterEach(() => {
    jest.restoreAllMocks()
  })

  it('does not warn when org membership check returns 404', async () => {
    const debugSpy = jest.spyOn(core, 'debug').mockImplementation()
    const warningSpy = jest.spyOn(core, 'warning').mockImplementation()

    const octokit = {
      orgs: {
        checkMembershipForUser: jest.fn().mockRejectedValue({
          status: 404,
          message: 'Not Found',
        }),
      },
    } as any

    const context = {
      payload: {
        repository: {
          owner: {
            login: 'cncf',
          },
        },
      },
    } as any

    const result = await checkOrgMember(octokit, context, 'test-user')

    expect(result).toBe(false)
    expect(debugSpy).toHaveBeenCalled()
    expect(warningSpy).not.toHaveBeenCalled()
  })

  it('warns when org membership check returns an unexpected error', async () => {
    const warningSpy = jest.spyOn(core, 'warning').mockImplementation()

    const octokit = {
      orgs: {
        checkMembershipForUser: jest.fn().mockRejectedValue({
          status: 500,
          message: 'Internal Server Error',
        }),
      },
    } as any

    const context = {
      payload: {
        repository: {
          owner: {
            login: 'cncf',
          },
        },
      },
    } as any

    const result = await checkOrgMember(octokit, context, 'test-user')

    expect(result).toBe(false)
    expect(warningSpy).toHaveBeenCalledWith(
      expect.stringContaining('status=500'),
    )
  })

  it('does not warn when collaborator check returns 404', async () => {
    const debugSpy = jest.spyOn(core, 'debug').mockImplementation()
    const warningSpy = jest.spyOn(core, 'warning').mockImplementation()

    const octokit = {
      repos: {
        checkCollaborator: jest.fn().mockRejectedValue({
          status: 404,
          message: 'Not Found',
        }),
      },
    } as any

    const context = {
      repo: {
        owner: 'cncf',
        repo: 'prow-github-actions',
      },
    } as any

    const result = await checkCollaborator(octokit, context, 'test-user')

    expect(result).toBe(false)
    expect(debugSpy).toHaveBeenCalled()
    expect(warningSpy).not.toHaveBeenCalled()
  })

  it('warns when collaborator check returns an unexpected error', async () => {
    const warningSpy = jest.spyOn(core, 'warning').mockImplementation()

    const octokit = {
      repos: {
        checkCollaborator: jest.fn().mockRejectedValue({
          status: 500,
          message: 'Internal Server Error',
        }),
      },
    } as any

    const context = {
      repo: {
        owner: 'cncf',
        repo: 'prow-github-actions',
      },
    } as any

    const result = await checkCollaborator(octokit, context, 'test-user')

    expect(result).toBe(false)
    expect(warningSpy).toHaveBeenCalledWith(
      expect.stringContaining('status=500'),
    )
  })

  it('warns when issue comments check returns an unexpected error', async () => {
    const warningSpy = jest.spyOn(core, 'warning').mockImplementation()

    const octokit = {
      issues: {
        listComments: jest.fn().mockRejectedValue({
          status: 500,
          message: 'Internal Server Error',
        }),
      },
    } as any

    const context = {
      repo: {
        owner: 'cncf',
        repo: 'prow-github-actions',
      },
    } as any

    const result = await checkIssueComments(
      octokit,
      context,
      39,
      'test-user',
    )

    expect(result).toBe(false)
    expect(warningSpy).toHaveBeenCalledWith(
      expect.stringContaining('status=500'),
    )
  })
})
