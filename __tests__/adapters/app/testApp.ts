import type { DeliveryStore } from '../../../src/adapters/app/dedupe'
import type { LogSink, TokenSource } from '../../../src/adapters/app/platform'
import type { AppSettings } from '../../../src/adapters/app/settings'
import type { WebhookReceiver } from '../../../src/adapters/app/webhook'
import type { Context } from '../../../src/platform'
import { sign } from '@octokit/webhooks-methods'

import { memoryDeliveryStore } from '../../../src/adapters/app/dedupe'

export const secret = 'test-webhook-secret'

export const settings: AppSettings = {
  appId: '42',
  privateKey: 'not-a-real-key',
  webhookSecret: secret,
  apiBaseUrl: 'https://api.github.com',
  inputs: { 'prow-commands': '/close /lgtm' },
}

export function recordingSink() {
  const lines: Record<string, unknown>[] = []
  const sink: LogSink = line => lines.push(line)
  return { lines, sink }
}

export function staticTokens(token = 'installation-token'): TokenSource & { requested: number[] } {
  const requested: number[] = []
  return {
    requested,
    async installationToken(id) {
      requested.push(id)
      return token
    },
  }
}

export function receiver(overrides: Partial<WebhookReceiver> = {}): WebhookReceiver & { dispatched: Context[], backgrounded: Promise<void>[] } {
  const dispatched: Context[] = []
  const backgrounded: Promise<void>[] = []
  const deliveries: DeliveryStore = memoryDeliveryStore()
  return {
    dispatched,
    backgrounded,
    settings,
    tokens: staticTokens(),
    deliveries,
    sink: () => {},
    dispatch: async (context) => {
      dispatched.push(context)
    },
    background: work => backgrounded.push(work),
    ...overrides,
  }
}

export async function signedRequest(eventName: string, payload: unknown, options: { id?: string, secret?: string, signature?: string, body?: string } = {}): Promise<Request> {
  const body = options.body ?? JSON.stringify(payload)
  const signature = options.signature ?? await sign(options.secret ?? secret, body)
  return new Request('https://prow.example/webhook', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-github-delivery': options.id ?? 'delivery-1',
      'x-github-event': eventName,
      'x-hub-signature-256': signature,
    },
    body,
  })
}

export function withInstallation<T extends object>(payload: T, id = 7): T & { installation: { id: number } } {
  return { ...structuredClone(payload), installation: { id } }
}
