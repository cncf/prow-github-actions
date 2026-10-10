import issueCommentEvent from '../fixtures/issues/issueCommentEvent.json'

// Fixture data shared by the unit tests (through ownersFixtures) and the bundle
// acceptance harness. It must not import src/ or testUtils: the bundle suite runs
// dist/index.js in a child process, and anything the vitest worker itself loads
// from src/ is merged into `npm run test:coverage:e2e` as if the bundle had run it.

// every fixture pull request targets master; its tip is basesha unless a test serves another
export const baseBranch = 'master'
export const baseSha = 'basesha'

export function prCommentEvent(body: string, commenter = 'Codertocat', author = 'some-author') {
  const event = structuredClone(issueCommentEvent)
  event.comment.body = body
  event.comment.user.login = commenter
  event.issue.user.login = author
  return {
    ...event,
    issue: {
      ...event.issue,
      pull_request: {
        url: 'https://api.github.com/repos/Codertocat/Hello-World/pulls/1',
      },
    },
  }
}

// an open, clean pull request without labels: the OWNERS plugins read its base, tide reads its labels and state
export const pullBody = {
  number: 1,
  state: 'open',
  locked: false,
  draft: false,
  merged: false,
  mergeable: true,
  mergeable_state: 'clean',
  labels: [],
  base: { ref: baseBranch, sha: baseSha },
  head: { sha: 'headsha' },
}

export function blobSha(path: string): string {
  return `blob-${path.replace(/\//g, '-')}`
}
