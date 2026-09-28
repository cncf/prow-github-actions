import { http } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { addFixedLabels, fixedLabelCommands, removeFixedLabels } from '../../src/labels/fixed'
import { hold } from '../../src/labels/hold'
import { lgtm } from '../../src/labels/lgtm'
import { addPrefixedLabels, prefixedLabelCommands, removePrefixedLabels } from '../../src/labels/prefixed'
import { remove } from '../../src/labels/remove'
import * as auth from '../../src/utils/auth'

import issuePayload from '../fixtures/issues/issue.json'
import issueCommentEvent from '../fixtures/issues/issueCommentEvent.json'
import labelFileContents from '../fixtures/labels/labelFileContentsResp.json'
import * as utils from '../testUtils'

// checkCollaborator swallows HTTP failures itself, so /remove's own
// "could not check commenter auth" branch is only reachable when it rejects
vi.mock('../../src/utils/auth', { spy: true })

const server = setupServer()
beforeAll(() =>
  server.listen({
    onUnhandledRequest: 'error',
  }),
)
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

const issue = `${utils.api}/repos/Codertocat/Hello-World/issues/1`
const forbidden = { message: 'Resource not accessible by integration' }
const helpCommand = fixedLabelCommands.find(cmd => cmd.command === '/help')!
const lifecycleCommand = prefixedLabelCommands.find(cmd => cmd.command === '/lifecycle')!

function comment(body: string) {
  const payload = structuredClone(issueCommentEvent)
  payload.comment.body = body
  return new utils.MockContext(payload)
}

function commentWithoutIssue(body: string) {
  const context = comment(body)
  delete context.payload.issue
  return context
}

function issueWithLabels(...names: string[]) {
  const payload = structuredClone(issuePayload)
  payload.labels = names.map(name => ({ ...payload.labels[0], name }))
  return payload
}

function issueLookupFails() {
  server.use(http.get(issue, utils.mockResponse(403, forbidden)))
}

beforeEach(() => {
  utils.setupActionsEnv()
})

describe('/remove error paths', () => {
  it('throws when the payload has no issue number', async () => {
    await expect(remove(commentWithoutIssue('/remove some-label'))).rejects.toThrow(
      /missing issue number/,
    )
  })

  it('wraps a failed commenter authorization check', async () => {
    vi.mocked(auth.checkCollaborator).mockRejectedValueOnce(new Error('auth exploded'))

    await expect(remove(comment('/remove some-label'))).rejects.toThrow(
      /could not check commenter auth: Error: auth exploded/,
    )
  })

  it('wraps a failed label lookup', async () => {
    vi.mocked(auth.checkCollaborator).mockResolvedValueOnce(true)
    issueLookupFails()

    await expect(remove(comment('/remove some-label'))).rejects.toThrow(
      /could not get labels from issue: Error: could not get issue/,
    )
  })
})

describe('/hold error paths', () => {
  it('throws when the payload has no issue number', async () => {
    await expect(hold(commentWithoutIssue('/hold'))).rejects.toThrow(/missing issue number/)
  })

  it('wraps a failed label lookup when cancelling', async () => {
    server.use(...utils.noOrgOrRepoConfigExcept())
    issueLookupFails()

    await expect(hold(comment('/hold cancel'))).rejects.toThrow(
      /could not get labels from issue: Error: could not get issue/,
    )
  })

  it('wraps a failed label removal when cancelling', async () => {
    server.use(
      ...utils.noOrgOrRepoConfigExcept(),
      http.get(issue, utils.mockResponse(200, issueWithLabels('do-not-merge/hold'))),
      http.delete(`${issue}/labels/:name`, utils.mockResponse(403, forbidden)),
    )

    await expect(hold(comment('/hold cancel'))).rejects.toThrow(/could not remove the hold label/)
  })
})

describe('/lgtm error paths', () => {
  it('throws when the payload has no issue number', async () => {
    await expect(lgtm(commentWithoutIssue('/lgtm'))).rejects.toThrow(/missing issue number/)
  })

  // the fixture's commenter is the issue author, who may cancel without a reviewer check
  it('wraps a failed label lookup when cancelling', async () => {
    issueLookupFails()

    await expect(lgtm(comment('/lgtm cancel'))).rejects.toThrow(
      /could not remove latest review: could not get labels from issue: Error: could not get issue/,
    )
  })

  it('wraps a failed label removal when cancelling', async () => {
    server.use(
      http.get(issue, utils.mockResponse(200, issueWithLabels('lgtm'))),
      http.delete(`${issue}/labels/lgtm`, utils.mockResponse(403, forbidden)),
    )

    await expect(lgtm(comment('/lgtm cancel'))).rejects.toThrow(
      /^could not remove latest review: (?!could not get labels)/,
    )
  })
})

describe('fixed label command error paths', () => {
  it('addFixedLabels throws when the payload has no issue number', async () => {
    await expect(addFixedLabels(commentWithoutIssue('/help'), helpCommand)).rejects.toThrow(
      /missing issue number/,
    )
  })

  it('removeFixedLabels throws when the payload has no issue number', async () => {
    await expect(removeFixedLabels(commentWithoutIssue('/remove-help'), helpCommand)).rejects.toThrow(
      /missing issue number/,
    )
  })

  it('removeFixedLabels wraps a failed label lookup', async () => {
    issueLookupFails()

    await expect(removeFixedLabels(comment('/remove-help'), helpCommand)).rejects.toThrow(
      /could not get labels from issue: Error: could not get issue/,
    )
  })
})

describe('prefixed label command error paths', () => {
  it('addPrefixedLabels throws when the payload has no issue number', async () => {
    await expect(
      addPrefixedLabels(commentWithoutIssue('/lifecycle stale'), lifecycleCommand),
    ).rejects.toThrow(/missing issue number/)
  })

  it('removePrefixedLabels throws when the payload has no issue number', async () => {
    await expect(
      removePrefixedLabels(commentWithoutIssue('/remove-lifecycle stale'), lifecycleCommand),
    ).rejects.toThrow(/missing issue number/)
  })

  it('removePrefixedLabels wraps a failed label lookup', async () => {
    server.use(
      http.get(utils.contentsUrl('.prowlabels.yaml'), utils.mockResponse(200, labelFileContents)),
      ...utils.noOrgOrRepoConfigExcept('.prowlabels.yaml'),
    )
    issueLookupFails()

    await expect(
      removePrefixedLabels(comment('/remove-lifecycle stale'), lifecycleCommand),
    ).rejects.toThrow(/could not get labels from issue: Error: could not get issue/)
  })
})
