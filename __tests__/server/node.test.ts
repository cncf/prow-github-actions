import { describe, expect, it } from 'vitest'

import { buildApp, buildReceiver } from '../../src/server/node'
import { signedRequest, withInstallation } from '../adapters/app/testApp'
import issueCommentEvent from '../fixtures/issues/issueCommentEvent.json'

const secret = 'node-secret'
const env = { GITHUB_APP_ID: '1', GITHUB_APP_PRIVATE_KEY: 'not-a-real-key', GITHUB_WEBHOOK_SECRET: secret }

describe('buildReceiver', () => {
  it('backgrounds the handler by default: the delivery is answered 202 while its dispatch is still running', async () => {
    let release!: () => void
    const released = new Promise<void>((resolve) => {
      release = resolve
    })
    let finish!: () => void
    const finished = new Promise<void>((resolve) => {
      finish = resolve
    })
    let dispatched = 0
    const receiver = buildReceiver(env)
    receiver.sink = () => {}
    receiver.tokens = { installationToken: async () => 'token' }
    receiver.dispatch = async () => {
      await released
      dispatched += 1
      finish()
    }

    const response = await buildApp(receiver).fetch(await signedRequest('issue_comment', withInstallation(issueCommentEvent), { secret }))

    expect(response.status).toBe(202)
    expect(dispatched).toBe(0)
    release()
    await finished
    expect(dispatched).toBe(1)
  })

  it('does not throw when the default background is handed settled work', () => {
    const receiver = buildReceiver(env)

    expect(() => receiver.background(Promise.resolve())).not.toThrow()
  })
})
