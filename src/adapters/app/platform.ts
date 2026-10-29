import type { Context, Logger, Platform, RunState } from '../../platform'
import type { AppSettings } from './settings'
import { createAppAuth } from '@octokit/auth-app'
import { request } from '@octokit/request'

import { newRunState } from '../../platform'

export interface Delivery {
  id: string
  eventName: string
  payload: Context['payload']
}

export interface AppRun {
  platform: Platform
  /** everything fail() was called with, in order */
  failures: string[]
  /** mints the installation token; inputs.get('github-token') is synchronous, so call this before dispatching */
  resolveToken: () => Promise<void>
}

export interface TokenSource {
  installationToken: (installationId: number) => Promise<string>
}

export function appTokenSource(settings: AppSettings): TokenSource {
  const auth = createAppAuth({ appId: settings.appId, privateKey: settings.privateKey, request: request.defaults({ baseUrl: settings.apiBaseUrl }) })
  return {
    async installationToken(installationId) {
      const { token } = await auth({ type: 'installation', installationId })
      return token
    },
  }
}

export function contextFromDelivery(delivery: Delivery): Context {
  const repository = delivery.payload.repository
  if (!repository) {
    throw new Error(`${delivery.eventName} delivery ${delivery.id} carries no repository`)
  }
  return {
    eventName: delivery.eventName,
    payload: delivery.payload,
    repo: { owner: repository.owner.login, repo: repository.name },
  }
}

export type LogSink = (line: Record<string, unknown>) => void

export function jsonLogger(sink: LogSink, fields: Record<string, unknown>, secrets: Set<string>): Logger {
  const emit = (level: string) => (message: string) => {
    let redacted = message
    for (const secret of secrets) {
      redacted = redacted.split(secret).join('***')
    }
    sink({ level, ...fields, message: redacted })
  }
  return {
    debug: emit('debug'),
    info: emit('info'),
    notice: emit('notice'),
    warning: emit('warning'),
    error: emit('error'),
    setSecret: (value) => {
      if (value) {
        secrets.add(value)
      }
    },
  }
}

/**
 * appPlatform builds the Platform one webhook delivery runs under: inputs from
 * the deployment, a token minted for the delivery's installation on first use,
 * one RunState, and a logger that tags every line with the delivery.
 */
export function appPlatform(settings: AppSettings, tokens: TokenSource, delivery: Delivery, sink: LogSink): AppRun {
  const context = contextFromDelivery(delivery)
  const installationId: unknown = delivery.payload.installation?.id
  if (typeof installationId !== 'number') {
    throw new TypeError(`${delivery.eventName} delivery ${delivery.id} carries no installation`)
  }
  const state: RunState = newRunState()
  const failures: string[] = []
  const secrets = new Set<string>([settings.webhookSecret, settings.privateKey])
  const log = jsonLogger(sink, { delivery: delivery.id, event: delivery.eventName, repo: `${context.repo.owner}/${context.repo.repo}` }, secrets)

  let token: string | undefined
  const platform: Platform = {
    inputs: {
      get: (name, options) => {
        if (name === 'github-token') {
          if (token === undefined) {
            throw new Error('the installation token is read asynchronously; call resolveToken() before dispatching')
          }
          return token
        }
        const value = settings.inputs[name] ?? ''
        if (options?.required && value === '') {
          throw new Error(`Input required and not supplied: ${name}`)
        }
        return value
      },
    },
    log,
    context: () => context,
    apiBaseUrl: () => settings.apiBaseUrl,
    currentWorkflowName: () => undefined,
    fail: (message) => {
      failures.push(message)
      log.error(message)
    },
    state: () => state,
    capabilities: () => ({ readOnlyForkToken: false }),
  }

  return {
    platform,
    failures,
    async resolveToken() {
      token = await tokens.installationToken(installationId)
      secrets.add(token)
    },
  }
}
