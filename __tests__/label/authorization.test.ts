import { Buffer } from 'node:buffer'
import * as core from '@actions/core'
import { http } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { handleIssueComment } from '../../src/issueComment/handleIssueComment'
import issuePayload from '../fixtures/issues/issue.json'
import issueCommentEvent from '../fixtures/issues/issueCommentEvent.json'

import * as utils from '../testUtils'

const server = setupServer()
beforeAll(() => server.listen(utils.failOnUnhandledRequest))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

const repo = `${utils.api}/repos/Codertocat/Hello-World`
const labelSections = 'labels:\n  kind: [bug, cleanup]\n  triage:\n    values: [accepted]\n'

let calls: string[]
function recordCall({ request }: { request: Request }) {
  calls.push(`${request.method} ${new URL(request.url).pathname}`)
}

beforeEach(() => {
  calls = []
  server.events.on('request:start', recordCall)
})

// the server outlives the test; an unremoved listener would record every later request again
afterEach(() => {
  server.events.removeListener('request:start', recordCall)
})

function prowYaml(text: string) {
  return [
    http.get(utils.contentsUrl('.github/prow.yaml'), utils.mockResponse(200, { type: 'file', encoding: 'base64', content: Buffer.from(text).toString('base64') })),
    ...utils.noOrgOrRepoConfigExcept('.github/prow.yaml'),
  ]
}

function issueWithLabels(...names: string[]) {
  const payload = structuredClone(issuePayload)
  for (const name of names) {
    payload.labels.push({ ...payload.labels[0], name })
  }
  return payload
}

// the command's own reads and writes; the needs-* re-check and the merge gate follow every label command
function serveIssue(config: string, currentLabels: string[] = []) {
  server.use(
    ...prowYaml(config),
    utils.defaultBranchTree(),
    http.get(`${repo}/issues/1`, utils.mockResponse(200, issueWithLabels(...currentLabels))),
    http.post(`${repo}/issues/1/labels`, utils.mockResponse(200, [])),
    http.delete(`${repo}/issues/1/labels/:name`, utils.mockResponse(200, [])),
    utils.repoHasLabels(['kind/bug', 'triage/accepted', 'help wanted', 'do-not-merge/hold']),
  )
}

function serveMembership(login: string, { member = false, collaborator = false } = {}) {
  server.use(
    http.get(`${utils.api}/orgs/Codertocat/members/${login}`, utils.mockResponse(member ? 204 : 404)),
    http.get(`${repo}/collaborators/${login}`, utils.mockResponse(collaborator ? 204 : 404)),
  )
}

function serveRootOwners(owners?: string) {
  server.use(http.get(
    `${repo}/contents/OWNERS`,
    owners === undefined
      ? utils.mockResponse(404)
      : utils.mockResponse(200, { type: 'file', encoding: 'base64', content: Buffer.from(owners).toString('base64') }),
  ))
}

async function run(commands: string, body: string, login: string) {
  utils.setupActionsEnv(commands)
  const payload = structuredClone(issueCommentEvent)
  payload.comment.body = body
  payload.comment.user.login = login
  const setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})
  await handleIssueComment(new utils.MockContext(payload))
  return setFailed
}

function authCalls() {
  return calls.filter(call => /\/members\/|\/collaborators\/|\/contents\/OWNERS$/.test(call))
}

function labelWrites() {
  return calls.filter(call => call.startsWith('POST') || call.startsWith('DELETE'))
}

describe('authorization.labels and authorization.hold', () => {
  describe('under the default anyone', () => {
    it.each([
      ['/kind', '/kind bug', `POST /repos/Codertocat/Hello-World/issues/1/labels`],
      ['/kind', '/remove-kind bug', `DELETE /repos/Codertocat/Hello-World/issues/1/labels/kind%2Fbug`],
      ['/triage', '/triage accepted', `POST /repos/Codertocat/Hello-World/issues/1/labels`],
      ['/help', '/help', `POST /repos/Codertocat/Hello-World/issues/1/labels`],
      ['/hold', '/hold', `POST /repos/Codertocat/Hello-World/issues/1/labels`],
      ['/hold', '/hold cancel', `DELETE /repos/Codertocat/Hello-World/issues/1/labels/do-not-merge%2Fhold`],
    ])('%s (%s) by an outsider makes no authorization call', async (commands, body, write) => {
      serveIssue(labelSections, ['kind/bug', 'do-not-merge/hold'])

      const setFailed = await run(commands, body, 'outsider')

      expect(setFailed).not.toHaveBeenCalled()
      expect(labelWrites()).toEqual([write])
      expect(authCalls()).toEqual([])
    })
  })

  describe('under trusted', () => {
    const trusted = `${labelSections}authorization:\n  labels: trusted\n  hold: trusted\n  users: [Friend]\n`

    it.each([
      ['/kind', '/kind bug', '/kind', 'labels'],
      ['/kind', '/remove-kind bug', '/remove-kind', 'labels'],
      ['/triage', '/triage accepted', '/triage', 'labels'],
      ['/help', '/help', '/help', 'labels'],
      ['/help', '/remove-help', '/remove-help', 'labels'],
      ['/hold', '/hold', '/hold', 'hold'],
      ['/hold', '/hold cancel', '/hold', 'hold'],
      ['/hold', '/unhold', '/hold', 'hold'],
      ['/hold', '/remove-hold', '/hold', 'hold'],
    ])('%s (%s) by an outsider fails the run and writes no label', async (commands, body, command, key) => {
      serveIssue(trusted, ['kind/bug', 'help wanted', 'do-not-merge/hold'])
      serveMembership('outsider')
      serveRootOwners('reviewers:\n  - someone-else\n')

      const setFailed = await run(commands, body, 'outsider')

      expect(setFailed).toHaveBeenCalledTimes(1)
      expect(setFailed).toHaveBeenCalledWith(expect.stringContaining(`outsider is not authorized to run ${command}: authorization.${key} is trusted`))
      expect(labelWrites()).toEqual([])
      expect(authCalls()).toEqual([
        'GET /orgs/Codertocat/members/outsider',
        'GET /repos/Codertocat/Hello-World/collaborators/outsider',
        'GET /repos/Codertocat/Hello-World/contents/OWNERS',
      ])
    })

    it.each([
      ['/triage', '/triage accepted'],
      ['/kind', '/remove-kind bug'],
      ['/help', '/help'],
      ['/hold', '/hold'],
      ['/hold', '/hold cancel'],
    ])('%s (%s) by a users login, in any case, is admitted without any membership call', async (commands, body) => {
      serveIssue(trusted, ['kind/bug', 'do-not-merge/hold'])

      const setFailed = await run(commands, body, 'FRIEND')

      expect(setFailed).not.toHaveBeenCalled()
      expect(labelWrites()).toHaveLength(1)
      expect(authCalls()).toEqual([])
    })

    it.each([
      ['/kind', '/kind bug'],
      ['/hold', '/hold'],
    ])('%s by a reviewer in the root OWNERS file is admitted', async (commands, body) => {
      serveIssue(trusted)
      serveMembership('rita')
      serveRootOwners('reviewers:\n  - rita\n')

      const setFailed = await run(commands, body, 'rita')

      expect(setFailed).not.toHaveBeenCalled()
      expect(labelWrites()).toEqual(['POST /repos/Codertocat/Hello-World/issues/1/labels'])
    })
  })

  describe('under members and collaborators', () => {
    it('members admits an org member without reading OWNERS', async () => {
      serveIssue(`${labelSections}authorization:\n  labels: members\n`)
      serveMembership('maria', { member: true })

      const setFailed = await run('/kind', '/kind bug', 'maria')

      expect(setFailed).not.toHaveBeenCalled()
      expect(authCalls()).toEqual(['GET /orgs/Codertocat/members/maria'])
    })

    it('collaborators refuses an org member who is not a collaborator, and a users login', async () => {
      serveIssue(`${labelSections}authorization:\n  hold: collaborators\n  users: [maria]\n`)
      serveMembership('maria', { member: true })

      const setFailed = await run('/hold', '/hold', 'maria')

      expect(setFailed).toHaveBeenCalledWith(expect.stringContaining('maria is not authorized to run /hold: authorization.hold is collaborators'))
      expect(labelWrites()).toEqual([])
      expect(authCalls()).toEqual(['GET /repos/Codertocat/Hello-World/collaborators/maria'])
    })
  })
})
