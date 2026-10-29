import type { Context, Platform } from '../platform'
import process from 'node:process'
import * as core from '@actions/core'
import * as github from '@actions/github'

export function actionsContext(): Context {
  const { eventName, payload, repo } = github.context
  return { eventName, payload, repo }
}

export function actionsPlatform(): Platform {
  return {
    inputs: {
      get: (name, options) => core.getInput(name, options),
    },
    log: {
      debug: message => core.debug(message),
      info: message => core.info(message),
      notice: message => core.notice(message),
      warning: message => core.warning(message),
      error: message => core.error(message),
      setSecret: value => core.setSecret(value),
    },
    context: actionsContext,
    apiBaseUrl: () => process.env.GITHUB_API_URL || 'https://api.github.com',
    currentWorkflowName: () => process.env.GITHUB_WORKFLOW,
    fail: message => core.setFailed(message),
  }
}
