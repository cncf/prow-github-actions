import type { ProwConfig, RequireMatchingLabel } from '../../src/utils/config'
import { Buffer } from 'node:buffer'
import * as core from '@actions/core'
import { http } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { handleIssueComment } from '../../src/issueComment/handleIssueComment'
import { handleIssues } from '../../src/issues/handleIssues'
import { applicableRules, checkRequiredLabels, evaluate, maxGracePeriodMs, parseDuration, requireMatchingLabel } from '../../src/plugins/requireMatchingLabel'
import { handlePullReq } from '../../src/pullReq/handlePullReq'
import * as sleepModule from '../../src/utils/sleep'
import issueCommentEvent from '../fixtures/issues/issueCommentEvent.json'
import issuesLabeledEvent from '../fixtures/issues/issuesLabeledEvent.json'
import labelFileContents from '../fixtures/labels/labelFileContentsResp.json'
import pullReqOpenedEvent from '../fixtures/pullReq/pullReqOpenedEvent.json'
import * as utils from '../testUtils'
import { pullHandler } from '../utils/ownersFixtures'

const server = setupServer()
beforeAll(() => server.listen({ onUnhandledRequest: 'error' }))
afterEach(() => server.resetHandlers())
afterAll(() => server.close())

const repo = `${utils.api}/repos/Codertocat/Hello-World`
const project = 'Codertocat/.project:prow.yaml'
const marker = '<!-- prow-github-actions/require-matching-label: needs-kind -->'

const kindRule: RequireMatchingLabel = {
  regexp: '^kind/',
  missing_label: 'needs-kind',
  missing_comment: 'Please add a kind label.',
}

function yamlFile(text: string) {
  const file = structuredClone(labelFileContents)
  file.content = Buffer.from(text).toString('base64')
  return file
}

function rulesYaml(rules: RequireMatchingLabel[]): string {
  return `require_matching_label:\n${rules.map(rule => `  - ${JSON.stringify(rule)}`).join('\n')}\n`
}

function serveRules(rules: RequireMatchingLabel[]) {
  server.use(
    http.get(utils.contentsUrl(project), utils.mockResponse(200, yamlFile(rulesYaml(rules)))),
    ...utils.noOrgOrRepoConfigExcept(project),
  )
}

function issueEvent(action: string, labels: string[], changed?: string) {
  const payload = structuredClone(issuesLabeledEvent)
  payload.action = action
  payload.issue.labels = labels.map(name => ({ ...payload.issue.labels[0], name }))
  if (changed !== undefined)
    payload.label = { ...payload.label, name: changed }
  return payload
}

interface Writes {
  addLabels: utils.ObserveRequest
  removeLabel: utils.ObserveRequest
  listComments: utils.ObserveRequest
  postComment: utils.ObserveRequest
  deleteComment: utils.ObserveRequest
}

function serveIssue(labels: string[], comments: { id: number, body: string, user: { login: string, type: string } }[] = []): Writes {
  const writes: Writes = {
    addLabels: new utils.ObserveRequest(),
    removeLabel: new utils.ObserveRequest(),
    listComments: new utils.ObserveRequest(),
    postComment: new utils.ObserveRequest(),
    deleteComment: new utils.ObserveRequest(),
  }
  server.use(
    http.get(`${repo}/issues/1`, utils.mockResponse(200, { labels: labels.map(name => ({ name })) })),
    utils.repoHasLabels(['needs-kind', 'needs-area', 'needs-size', 'kind/bug']),
    http.post(`${repo}/issues/1/labels`, utils.mockResponse(200, [], writes.addLabels)),
    http.delete(`${repo}/issues/1/labels/:name`, utils.mockResponse(200, [], writes.removeLabel)),
    http.get(`${repo}/issues/1/comments`, utils.mockResponse(200, comments, writes.listComments)),
    http.post(`${repo}/issues/1/comments`, utils.mockResponse(201, {}, writes.postComment)),
    http.delete(`${repo}/issues/comments/:id`, utils.mockResponse(204, null, writes.deleteComment)),
  )
  return writes
}

function prEvent(action: string, labels: string[], changed?: string) {
  const payload: Record<string, unknown> = structuredClone(pullReqOpenedEvent)
  payload.action = action
  ;(payload.pull_request as { labels: unknown[] }).labels = labels.map(name => ({ name }))
  if (changed !== undefined)
    payload.label = { name: changed }
  return payload
}

function commentEvent(body: string, overrides: Record<string, unknown> = {}) {
  const payload = structuredClone(issueCommentEvent)
  payload.comment.body = body
  return { ...payload, issue: { ...payload.issue, ...overrides } }
}

function configWith(...rules: RequireMatchingLabel[]): ProwConfig {
  return { labels: {}, require_matching_label: rules, tide: {}, hold: {}, blunderbuss: {}, sources: [] }
}

const botComment = { id: 11, body: `Please add a kind label.\n\n${marker}`, user: { login: 'github-actions[bot]', type: 'Bot' } }
const humanComment = { id: 12, body: `I pasted the marker by hand ${marker}`, user: { login: 'Codertocat', type: 'User' } }

describe('evaluate', () => {
  it.each([
    [['kind/bug', 'needs-kind'], 'remove'],
    [['area/docs'], 'add'],
    [['kind/bug'], 'none'],
    [['needs-kind'], 'none'],
  ])('%j -> %s', (labels, verdict) => {
    expect(evaluate(kindRule, labels)).toBe(verdict)
  })

  it('matches the missing label case-insensitively and the regexp case-sensitively', () => {
    expect(evaluate(kindRule, ['Needs-Kind'])).toBe('none')
    expect(evaluate(kindRule, ['Kind/bug'])).toBe('add')
  })
})

describe('applicableRules', () => {
  const issuesOnly: RequireMatchingLabel = { regexp: '^area/', missing_label: 'needs-area', issues: true }
  const prsOnly: RequireMatchingLabel = { regexp: '^size/', missing_label: 'needs-size', prs: true }
  const both: RequireMatchingLabel = { regexp: '^kind/', missing_label: 'needs-kind', issues: true, prs: true }
  const config = configWith(issuesOnly, prsOnly, both)

  it('filters by issues and prs', () => {
    expect(applicableRules(config, false)).toEqual([issuesOnly, both])
    expect(applicableRules(config, true)).toEqual([prsOnly, both])
  })

  it('filters by the changed label: regexp match, missing_label match, neither', () => {
    expect(applicableRules(config, false, 'kind/bug')).toEqual([both])
    expect(applicableRules(config, true, 'Needs-Size')).toEqual([prsOnly])
    expect(applicableRules(config, false, 'priority/high')).toEqual([])
  })
})

describe('parseDuration', () => {
  it.each([
    ['5s', 5000],
    ['2m', 120_000],
    ['500ms', 500],
    ['1h', 3_600_000],
    ['1m30s', 90_000],
    ['1.5s', 1500],
    ['0', 0],
    ['', 0],
    [undefined, 0],
  ])('%s -> %d ms', (text, ms) => {
    expect(parseDuration(text)).toBe(ms)
  })

  it.each(['5', 'soon', '5 s', '5d', '-5s'])('rejects %s', (text) => {
    expect(() => parseDuration(text)).toThrow(`invalid grace_period_duration '${text}'`)
  })
})

describe('requireMatchingLabel handler', () => {
  let setFailed: ReturnType<typeof vi.spyOn>
  let sleep: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    utils.setupActionsEnv()
    setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})
    sleep = vi.spyOn(sleepModule, 'sleep').mockResolvedValue(undefined)
  })

  it('issue opened without a kind label waits the grace period, then adds needs-kind and the comment', async () => {
    serveRules([{ ...kindRule, grace_period_duration: '5s' }, { regexp: '^area/', missing_label: 'needs-area', issues: true, grace_period_duration: '2s' }])
    const writes = serveIssue(['area/docs'])

    await requireMatchingLabel(new utils.MockContext(issueEvent('opened', [])))

    expect(sleep).toHaveBeenCalledExactlyOnceWith(5000)
    await expect(writes.addLabels.called()).resolves.toBe('called')
    expect(await writes.addLabels.body()).toEqual({ labels: ['needs-kind'] })
    await expect(writes.postComment.called()).resolves.toBe('called')
    expect(await writes.postComment.body()).toEqual({ body: `Please add a kind label.\n\n${marker}` })
    expect(setFailed).not.toHaveBeenCalled()
  })

  it('issue labeled kind/bug with needs-kind present removes the label and the bot comment only', async () => {
    serveRules([kindRule])
    const writes = serveIssue(['kind/bug', 'needs-kind'], [botComment, humanComment])

    await requireMatchingLabel(new utils.MockContext(issueEvent('labeled', ['kind/bug', 'needs-kind'], 'kind/bug')))

    expect(sleep).not.toHaveBeenCalled()
    await expect(writes.removeLabel.called()).resolves.toBe('called')
    expect(writes.removeLabel.ref?.url).toBe(`${repo}/issues/1/labels/needs-kind`)
    await expect(writes.deleteComment.called()).resolves.toBe('called')
    expect(writes.deleteComment.ref?.url).toBe(`${repo}/issues/comments/11`)
    await expect(writes.addLabels.notCalled()).resolves.toBe('not called')
    await expect(writes.postComment.notCalled()).resolves.toBe('not called')
    expect(setFailed).not.toHaveBeenCalled()
  })

  it('issue opened with a kind label already present touches nothing', async () => {
    serveRules([kindRule])
    const writes = serveIssue(['kind/bug'])

    await requireMatchingLabel(new utils.MockContext(issueEvent('opened', ['kind/bug'])))

    await expect(writes.addLabels.notCalled()).resolves.toBe('not called')
    expect(writes.removeLabel.ref).toBeNull()
    expect(writes.listComments.ref).toBeNull()
    expect(writes.postComment.ref).toBeNull()
    expect(setFailed).not.toHaveBeenCalled()
  })

  it('reopened re-fetches the labels after the grace period, capped at 30s', async () => {
    serveRules([{ ...kindRule, grace_period_duration: '10m' }])
    const writes = serveIssue(['kind/bug'])
    const order: string[] = []
    sleep.mockImplementation(async () => {
      order.push('sleep')
    })
    server.use(http.get(`${repo}/issues/1`, async () => {
      order.push('labels')
      return new Response(JSON.stringify({ labels: [{ name: 'kind/bug' }] }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    }))

    await requireMatchingLabel(new utils.MockContext(issueEvent('reopened', [])))

    expect(sleep).toHaveBeenCalledExactlyOnceWith(maxGracePeriodMs)
    expect(order).toEqual(['sleep', 'labels'])
    await expect(writes.addLabels.notCalled()).resolves.toBe('not called')
    expect(setFailed).not.toHaveBeenCalled()
  })

  it('fails on a malformed grace_period_duration without touching the issue', async () => {
    serveRules([{ ...kindRule, grace_period_duration: 'soon' }])
    const writes = serveIssue([])

    await expect(requireMatchingLabel(new utils.MockContext(issueEvent('opened', [])))).rejects.toThrow(
      `invalid grace_period_duration 'soon'`,
    )

    expect(sleep).not.toHaveBeenCalled()
    await expect(writes.addLabels.notCalled()).resolves.toBe('not called')
  })

  it('issue labeled with an unrelated label makes no writes', async () => {
    serveRules([kindRule])
    const writes = serveIssue(['priority/high'])
    const issueRead = new utils.ObserveRequest()
    server.use(http.get(`${repo}/issues/1`, utils.mockResponse(200, { labels: [] }, issueRead)))

    await requireMatchingLabel(new utils.MockContext(issueEvent('labeled', ['priority/high'], 'priority/high')))

    await expect(writes.addLabels.notCalled()).resolves.toBe('not called')
    expect(issueRead.ref).toBeNull()
    expect(writes.removeLabel.ref).toBeNull()
    expect(setFailed).not.toHaveBeenCalled()
  })

  it('issue unlabeled of the last kind/* label adds needs-kind', async () => {
    serveRules([kindRule])
    const writes = serveIssue([])

    await requireMatchingLabel(new utils.MockContext(issueEvent('unlabeled', [], 'kind/bug')))

    await expect(writes.addLabels.called()).resolves.toBe('called')
    expect(await writes.addLabels.body()).toEqual({ labels: ['needs-kind'] })
    await expect(writes.postComment.called()).resolves.toBe('called')
    expect(setFailed).not.toHaveBeenCalled()
  })

  it('issue unlabeled of needs-kind by hand while nothing matches re-adds it', async () => {
    serveRules([kindRule])
    const writes = serveIssue([], [botComment])

    await requireMatchingLabel(new utils.MockContext(issueEvent('unlabeled', [], 'needs-kind')))

    await expect(writes.addLabels.called()).resolves.toBe('called')
    expect(await writes.addLabels.body()).toEqual({ labels: ['needs-kind'] })
    await expect(writes.postComment.notCalled()).resolves.toBe('not called')
    expect(setFailed).not.toHaveBeenCalled()
  })

  it('removes the missing label with the casing it has on the issue', async () => {
    serveRules([kindRule])
    const writes = serveIssue(['kind/bug', 'Needs-Kind'])

    await requireMatchingLabel(new utils.MockContext(issueEvent('labeled', [], 'kind/bug')))

    await expect(writes.removeLabel.called()).resolves.toBe('called')
    expect(writes.removeLabel.ref?.url).toBe(`${repo}/issues/1/labels/Needs-Kind`)
    expect(setFailed).not.toHaveBeenCalled()
  })

  it('pull request opened applies a prs rule using the pull request labels', async () => {
    serveRules([{ regexp: '^kind/', missing_label: 'needs-kind', prs: true, missing_comment: 'Please add a kind label.' }])
    const writes = serveIssue([])

    await requireMatchingLabel(new utils.MockContext(prEvent('opened', [])))

    await expect(writes.addLabels.called()).resolves.toBe('called')
    expect(await writes.addLabels.body()).toEqual({ labels: ['needs-kind'] })
    await expect(writes.postComment.called()).resolves.toBe('called')
    expect(setFailed).not.toHaveBeenCalled()
  })

  it('pull request opened ignores a rule with prs: false', async () => {
    serveRules([{ regexp: '^kind/', missing_label: 'needs-kind', issues: true, prs: false }])
    const writes = serveIssue([])

    await requireMatchingLabel(new utils.MockContext(prEvent('opened', [])))

    await expect(writes.addLabels.notCalled()).resolves.toBe('not called')
    expect(setFailed).not.toHaveBeenCalled()
  })

  it('pull request labeled with kind/bug runs through handlePullReq and removes needs-kind', async () => {
    utils.setupJobsEnv('lgtm')
    serveRules([{ regexp: '^kind/', missing_label: 'needs-kind', prs: true }])
    const writes = serveIssue(['kind/bug', 'needs-kind'])
    // tide evaluates the pull request on labeled too: it learns the gate from the default branch tree and stops at the missing lgtm
    server.use(pullHandler(), utils.defaultBranchTree())

    await handlePullReq(new utils.MockContext(prEvent('labeled', ['kind/bug', 'needs-kind'], 'kind/bug')))

    await expect(writes.removeLabel.called()).resolves.toBe('called')
    expect(writes.listComments.ref).toBeNull()
    expect(setFailed).not.toHaveBeenCalled()
  })

  it('without missing_comment it never reads or writes comments', async () => {
    serveRules([{ regexp: '^kind/', missing_label: 'needs-kind' }])
    const writes = serveIssue([])

    await requireMatchingLabel(new utils.MockContext(issueEvent('opened', [])))

    await expect(writes.addLabels.called()).resolves.toBe('called')
    expect(writes.listComments.ref).toBeNull()
    expect(writes.postComment.ref).toBeNull()
    expect(setFailed).not.toHaveBeenCalled()
  })

  it('does not post a second comment when the marker comment already exists', async () => {
    serveRules([kindRule])
    const writes = serveIssue([], [botComment])

    await requireMatchingLabel(new utils.MockContext(issueEvent('opened', [])))

    await expect(writes.addLabels.called()).resolves.toBe('called')
    await expect(writes.listComments.called()).resolves.toBe('called')
    await expect(writes.postComment.notCalled()).resolves.toBe('not called')
    expect(setFailed).not.toHaveBeenCalled()
  })

  it('with zero rules configured it makes no api calls beyond the configuration reads', async () => {
    server.use(...utils.noOrgOrRepoConfigExcept())
    const writes = serveIssue([])
    const issueRead = new utils.ObserveRequest()
    server.use(http.get(`${repo}/issues/1`, utils.mockResponse(200, { labels: [] }, issueRead)))

    await requireMatchingLabel(new utils.MockContext(issueEvent('opened', [])))

    await expect(writes.addLabels.notCalled()).resolves.toBe('not called')
    expect(issueRead.ref).toBeNull()
    expect(setFailed).not.toHaveBeenCalled()
  })

  it.each(['edited', 'closed', 'assigned', 'synchronize'])('skips the %s action without calling the api', async (action) => {
    const debug = vi.spyOn(core, 'debug').mockImplementation(() => {})

    await requireMatchingLabel(new utils.MockContext(issueEvent(action, [])))

    expect(debug).toHaveBeenCalledWith(`require-matching-label: skipping ${action} action`)
  })

  it('surfaces the missing repository label error through the issues event', async () => {
    serveRules([{ regexp: '^kind/', missing_label: 'needs-kind' }])
    serveIssue([])
    server.use(utils.repoHasLabels(['kind/bug']))

    await handleIssues(new utils.MockContext(issueEvent('opened', [])))

    expect(setFailed).toHaveBeenCalledExactlyOnceWith(
      `error handling issues event: require-matching-label needs-kind: the label(s) needs-kind cannot be applied because the repository doesn't have them. Run the label-sync job or create them.`,
    )
  })

  it('names the rule when a comment cannot be deleted and still applies the other rules', async () => {
    serveRules([kindRule, { regexp: '^area/', missing_label: 'needs-area', issues: true }])
    const writes = serveIssue(['kind/bug', 'needs-kind'], [botComment])
    server.use(http.delete(`${repo}/issues/comments/:id`, utils.mockResponse(500, { message: 'boom' })))

    await expect(requireMatchingLabel(new utils.MockContext(issueEvent('opened', [])))).rejects.toThrow(
      /^require-matching-label needs-kind: could not delete comment 11: .*boom/,
    )

    await expect(writes.removeLabel.called()).resolves.toBe('called')
    await expect(writes.addLabels.called()).resolves.toBe('called')
    expect(await writes.addLabels.body()).toEqual({ labels: ['needs-area'] })
  })

  it('is registered on the issues event', async () => {
    serveRules([kindRule])
    const writes = serveIssue(['kind/bug', 'needs-kind'], [botComment])

    await handleIssues(new utils.MockContext(issueEvent('labeled', ['kind/bug', 'needs-kind'], 'kind/bug')))

    await expect(writes.removeLabel.called()).resolves.toBe('called')
    expect(setFailed).not.toHaveBeenCalled()
  })
})

describe('/check-required-labels', () => {
  let setFailed: ReturnType<typeof vi.spyOn>
  let sleep: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    utils.setupActionsEnv('/check-required-labels')
    setFailed = vi.spyOn(core, 'setFailed').mockImplementation(() => {})
    sleep = vi.spyOn(sleepModule, 'sleep').mockResolvedValue(undefined)
  })

  it('evaluates every applicable rule on an open issue without sleeping', async () => {
    serveRules([{ ...kindRule, grace_period_duration: '5s' }, { regexp: '^area/', missing_label: 'needs-area', issues: true }])
    const writes = serveIssue(['needs-area', 'area/docs'])

    await handleIssueComment(new utils.MockContext(commentEvent('/check-required-labels')))

    expect(sleep).not.toHaveBeenCalled()
    await expect(writes.addLabels.called()).resolves.toBe('called')
    expect(await writes.addLabels.body()).toEqual({ labels: ['needs-kind'] })
    await expect(writes.postComment.called()).resolves.toBe('called')
    await expect(writes.removeLabel.called()).resolves.toBe('called')
    expect(writes.removeLabel.ref?.url).toBe(`${repo}/issues/1/labels/needs-area`)
    expect(setFailed).not.toHaveBeenCalled()
  })

  it('applies the prs rules when the comment is on a pull request', async () => {
    serveRules([{ regexp: '^kind/', missing_label: 'needs-kind', issues: true }, { regexp: '^size/', missing_label: 'needs-size', prs: true }])
    const writes = serveIssue([])

    await checkRequiredLabels(new utils.MockContext(commentEvent('/check-required-labels', { pull_request: { url: `${repo}/pulls/1` } })))

    await expect(writes.addLabels.called()).resolves.toBe('called')
    expect(await writes.addLabels.body()).toEqual({ labels: ['needs-size'] })
  })

  it('does nothing on a closed issue', async () => {
    const debug = vi.spyOn(core, 'debug').mockImplementation(() => {})

    await checkRequiredLabels(new utils.MockContext(commentEvent('/check-required-labels', { state: 'closed' })))

    expect(debug).toHaveBeenCalledWith('require-matching-label: the issue is not open, nothing to check')
  })

  it('has no /remove- form', async () => {
    await handleIssueComment(new utils.MockContext(commentEvent('/remove-check-required-labels')))

    expect(setFailed).not.toHaveBeenCalled()
  })

  it('does not run when the command is not configured', async () => {
    utils.setupActionsEnv('/kind')

    await handleIssueComment(new utils.MockContext(commentEvent('/check-required-labels')))

    expect(setFailed).not.toHaveBeenCalled()
  })

  it('fails the run with the rule name when the label cannot be added', async () => {
    serveRules([{ regexp: '^kind/', missing_label: 'needs-kind' }])
    serveIssue([])
    server.use(http.post(`${repo}/issues/1/labels`, utils.mockResponse(500, { message: 'boom' })))

    await handleIssueComment(new utils.MockContext(commentEvent('/check-required-labels')))

    expect(setFailed).toHaveBeenCalledExactlyOnceWith(
      expect.stringMatching(/^TypeError: error handling issue comment: Error: require-matching-label needs-kind: could not add labels: .*boom/),
    )
  })
})
