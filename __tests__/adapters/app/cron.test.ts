import type { InstallationLister, ScheduledRepository } from '../../../src/adapters/app/cron'
import type { Context } from '../../../src/platform'
import { generateKeyPairSync } from 'node:crypto'
import { http } from 'msw'
import { setupServer } from 'msw/node'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import { appInstallationLister, runScheduledJobs } from '../../../src/adapters/app/cron'
import { appTokenSource } from '../../../src/adapters/app/platform'
import { asyncLocalScope } from '../../../src/adapters/app/scope'
import { handleCronJobs } from '../../../src/cronJobs/handleCronJob'
import { globalPlatformScope, installPlatformScope, platform } from '../../../src/platform'
import * as utils from '../../testUtils'
import { recordingSink, settings, staticTokens } from './testApp'

function repo(owner: string, name: string): ScheduledRepository['repository'] {
  return { name, full_name: `${owner}/${name}`, owner: { login: owner } }
}

function listing(...targets: ScheduledRepository[]): InstallationLister {
  return {
    async* repositories() {
      yield* targets
    },
  }
}

const targets = [
  { installationId: 1, repository: repo('acme', 'api') },
  { installationId: 1, repository: repo('acme', 'web') },
  { installationId: 2, repository: repo('globex', 'core') },
  { installationId: 2, repository: repo('globex', 'docs') },
]

describe('runScheduledJobs', () => {
  beforeAll(() => installPlatformScope(asyncLocalScope()))
  afterAll(() => installPlatformScope(globalPlatformScope))

  it('runs the jobs once per repository, each under its own platform, token and schedule context', async () => {
    const seen: { context: Context, token: string, jobs: string, state: object }[] = []
    const tokens = staticTokens()
    tokens.installationToken = async (id) => {
      tokens.requested.push(id)
      return `tok-${id}`
    }

    const report = await runScheduledJobs({
      settings: { ...settings, inputs: { jobs: 'lgtm' } },
      tokens,
      installations: listing(...targets),
      sink: () => {},
      dispatch: async (context) => {
        seen.push({ context, token: platform().inputs.get('github-token'), jobs: platform().inputs.get('jobs'), state: platform().state() })
      },
    })

    expect(report).toEqual({ repositories: 4, failed: [] })
    expect(seen.map(s => `${s.context.repo.owner}/${s.context.repo.repo}:${s.token}`).sort()).toEqual(['acme/api:tok-1', 'acme/web:tok-1', 'globex/core:tok-2', 'globex/docs:tok-2'])
    expect(seen[0]!.context).toMatchObject({ eventName: 'schedule', payload: { installation: { id: 1 } } })
    expect(seen.every(s => s.jobs === 'lgtm')).toBe(true)
    expect(new Set(seen.map(s => s.state)).size).toBe(4)
  })

  it('runs at most `concurrency` repositories at once', async () => {
    let active = 0
    let peak = 0
    await runScheduledJobs({
      settings,
      tokens: staticTokens(),
      installations: listing(...targets, ...targets),
      sink: () => {},
      concurrency: 3,
      dispatch: async () => {
        active++
        peak = Math.max(peak, active)
        await new Promise(resolve => setTimeout(resolve, 5))
        active--
      },
    })

    expect(peak).toBe(3)
  })

  it('reports a repository whose handler throws or fails, and keeps going', async () => {
    const { lines, sink } = recordingSink()
    const report = await runScheduledJobs({
      settings,
      tokens: staticTokens(),
      installations: listing(...targets),
      sink,
      dispatch: async (context) => {
        if (context.repo.repo === 'web') {
          throw new Error('web is broken')
        }
        if (context.repo.repo === 'core') {
          platform().fail('core refused')
        }
      },
    })

    expect(report.repositories).toBe(4)
    expect(report.failed.sort()).toEqual(['acme/web', 'globex/core'])
    expect(lines).toContainEqual(expect.objectContaining({ level: 'error', repo: 'acme/web', message: 'web is broken' }))
    expect(lines).toContainEqual(expect.objectContaining({ level: 'error', repo: 'globex/core', message: 'core refused' }))
    expect(lines.at(-1)).toMatchObject({ level: 'info', message: 'scheduled jobs ran for 4 repositories, 2 failed' })
  })

  it('reports a repository whose handler throws a non-Error as its string form', async () => {
    const { lines, sink } = recordingSink()
    const report = await runScheduledJobs({
      settings,
      tokens: staticTokens(),
      installations: listing(...targets),
      sink,
      dispatch: async (context) => {
        if (context.repo.repo === 'docs') {
          // eslint-disable-next-line no-throw-literal
          throw { code: 'ECONNRESET' }
        }
      },
    })

    expect(report).toEqual({ repositories: 4, failed: ['globex/docs'] })
    expect(lines).toContainEqual({ level: 'error', event: 'schedule', repo: 'globex/docs', message: '[object Object]' })
  })

  it('reports a repository whose token cannot be minted', async () => {
    const report = await runScheduledJobs({
      settings,
      tokens: { installationToken: async (id) => {
        if (id === 2) {
          throw new Error('suspended')
        }
        return 't'
      } },
      installations: listing(...targets),
      sink: () => {},
      dispatch: async () => {},
    })

    expect(report.failed.sort()).toEqual(['globex/core', 'globex/docs'])
  })
})

describe('runScheduledJobs dispatching handleCronJobs', () => {
  const server = setupServer()
  utils.failTestOnUnhandledRequests(server)
  beforeAll(() => {
    installPlatformScope(asyncLocalScope())
    server.listen(utils.failOnUnhandledRequest)
  })
  afterEach(() => server.resetHandlers())
  afterAll(() => {
    server.close()
    installPlatformScope(globalPlatformScope)
  })

  // the App hands PROW_JOBS over as the environment carries it (settingsFromEnv does not trim, unlike
  // core.getInput on Actions), and a ConfigMap block scalar ends in a newline; the empty token that
  // splitting such a value leaves behind must not reach the "no jobs" arm and fail every repository
  it('runs the jobs named by a PROW_JOBS value carrying a trailing newline, failing no repository', async () => {
    const { lines, sink } = recordingSink()
    server.use(
      ...utils.noOrgOrRepoConfigExcept(),
      http.get(`${utils.api}/repos/Codertocat/Hello-World/pulls`, utils.mockResponse(200, [])),
    )

    const report = await runScheduledJobs({
      settings: { ...settings, inputs: { jobs: 'lgtm\n' } },
      tokens: staticTokens(),
      installations: listing({ installationId: 7, repository: repo('Codertocat', 'Hello-World') }),
      sink,
      dispatch: context => handleCronJobs(context),
    })

    expect(report).toEqual({ repositories: 1, failed: [] })
    expect(lines.filter(line => line.level === 'error')).toEqual([])
  })
})

describe('appInstallationLister', () => {
  const server = setupServer()
  utils.failTestOnUnhandledRequests(server)
  beforeAll(() => server.listen(utils.failOnUnhandledRequest))
  afterEach(() => server.resetHandlers())
  afterAll(() => server.close())

  const api = 'https://ghes.example/api/v3'
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs1', format: 'pem' }, publicKeyEncoding: { type: 'pkcs1', format: 'pem' } })

  it('lists every repository of every installation over every page, skipping suspended installations and archived repositories', async () => {
    server.use(
      http.get(`${api}/app/installations`, ({ request }) => {
        const p = new URL(request.url).searchParams.get('page') ?? '1'
        const headers: Record<string, string> = { 'Content-Type': 'application/json' }
        if (p === '1') {
          headers.Link = `<${api}/app/installations?per_page=100&page=2>; rel="next"`
        }
        const body = p === '1'
          ? [{ id: 1, suspended_at: null }, { id: 9, suspended_at: '2026-01-01T00:00:00Z' }]
          : [{ id: 2, suspended_at: null }]
        return new Response(JSON.stringify(body), { headers })
      }),
      http.post(`${api}/app/installations/:id/access_tokens`, ({ params }) => new Response(JSON.stringify({ token: `tok-${params.id}`, expires_at: new Date(Date.now() + 3_600_000).toISOString(), permissions: {}, repository_selection: 'all' }), { status: 201, headers: { 'Content-Type': 'application/json' } })),
      http.get(`${api}/installation/repositories`, ({ request }) => {
        const token = request.headers.get('authorization')
        const repos = token === 'token tok-1'
          ? [{ name: 'api', full_name: 'acme/api', owner: { login: 'acme' }, archived: false }, { name: 'old', full_name: 'acme/old', owner: { login: 'acme' }, archived: true }]
          : [{ name: 'core', full_name: 'globex/core', owner: { login: 'globex' }, archived: false }]
        return new Response(JSON.stringify({ total_count: repos.length, repositories: repos }), { headers: { 'Content-Type': 'application/json' } })
      }),
    )

    const out: ScheduledRepository[] = []
    for await (const target of appInstallationLister({ ...settings, privateKey, apiBaseUrl: api }, appTokenSource({ ...settings, privateKey, apiBaseUrl: api }), () => {}).repositories()) {
      out.push(target)
    }

    expect(out.map(t => `${t.installationId}:${t.repository.full_name}`)).toEqual(['1:acme/api', '2:globex/core'])
  })

  it.each([
    ['its token cannot be minted', 'access_tokens'],
    ['its repositories cannot be listed', 'repositories'],
  ])('logs and skips an installation when %s, and lists the others', async (_case, failing) => {
    server.use(
      http.get(`${api}/app/installations`, () => new Response(JSON.stringify([{ id: 1, suspended_at: null }, { id: 2, suspended_at: null }]), { headers: { 'Content-Type': 'application/json' } })),
      http.post(`${api}/app/installations/:id/access_tokens`, ({ params }) => failing === 'access_tokens' && params.id === '1'
        ? new Response(JSON.stringify({ message: 'Resource not accessible by integration' }), { status: 403, headers: { 'Content-Type': 'application/json' } })
        : new Response(JSON.stringify({ token: `tok-${params.id}`, expires_at: new Date(Date.now() + 3_600_000).toISOString(), permissions: {}, repository_selection: 'all' }), { status: 201, headers: { 'Content-Type': 'application/json' } })),
      http.get(`${api}/installation/repositories`, ({ request }) => {
        if (failing === 'repositories' && request.headers.get('authorization') === 'token tok-1') {
          return new Response(JSON.stringify({ message: 'Resource not accessible by integration' }), { status: 403, headers: { 'Content-Type': 'application/json' } })
        }
        const repos = [{ name: 'core', full_name: 'globex/core', owner: { login: 'globex' }, archived: false }]
        return new Response(JSON.stringify({ total_count: repos.length, repositories: repos }), { headers: { 'Content-Type': 'application/json' } })
      }),
    )
    const { lines, sink } = recordingSink()

    const out: ScheduledRepository[] = []
    for await (const target of appInstallationLister({ ...settings, privateKey, apiBaseUrl: api }, appTokenSource({ ...settings, privateKey, apiBaseUrl: api }), sink).repositories()) {
      out.push(target)
    }

    expect(out.map(t => `${t.installationId}:${t.repository.full_name}`)).toEqual(['2:globex/core'])
    expect(lines).toEqual([expect.objectContaining({ level: 'error', event: 'schedule', installationId: 1, message: expect.stringMatching(/^could not list the repositories of installation 1: .*Resource not accessible by integration/) })])
  })

  it('logs an installation whose token source rejects with a non-Error value as its string form', async () => {
    server.use(
      http.get(`${api}/app/installations`, () => new Response(JSON.stringify([{ id: 1, suspended_at: null }]), { headers: { 'Content-Type': 'application/json' } })),
    )
    const { lines, sink } = recordingSink()
    const tokens = { installationToken: vi.fn<(id: number) => Promise<string>>().mockRejectedValue('plain string failure') }

    const out: ScheduledRepository[] = []
    for await (const target of appInstallationLister({ ...settings, privateKey, apiBaseUrl: api }, tokens, sink).repositories()) {
      out.push(target)
    }

    expect(out).toEqual([])
    expect(lines).toEqual([expect.objectContaining({ installationId: 1, message: 'could not list the repositories of installation 1: plain string failure' })])
  })

  it('installations() mints no token and lists no repository; repositoriesOf() reaches only the installation it is given', async () => {
    const seen: string[] = []
    server.use(
      http.get(`${api}/app/installations`, () => {
        seen.push('list installations')
        return Response.json([{ id: 1, suspended_at: null }, { id: 9, suspended_at: '2026-01-01T00:00:00Z' }, { id: 2, suspended_at: null }])
      }),
      http.post(`${api}/app/installations/:id/access_tokens`, ({ params }) => {
        seen.push(`mint ${String(params.id)}`)
        return Response.json({ token: `tok-${String(params.id)}`, expires_at: new Date(Date.now() + 3_600_000).toISOString(), permissions: {}, repository_selection: 'all' }, { status: 201 })
      }),
      http.get(`${api}/installation/repositories`, ({ request }) => {
        seen.push(`list repositories as ${String(request.headers.get('authorization'))}`)
        return Response.json({ total_count: 2, repositories: [{ name: 'core', full_name: 'globex/core', owner: { login: 'globex' }, archived: false }, { name: 'old', full_name: 'globex/old', owner: { login: 'globex' }, archived: true }] })
      }),
    )
    const lister = appInstallationLister({ ...settings, privateKey, apiBaseUrl: api }, appTokenSource({ ...settings, privateKey, apiBaseUrl: api }), recordingSink().sink)

    const ids: number[] = []
    for await (const id of lister.installations()) {
      ids.push(id)
    }
    expect(ids).toEqual([1, 2])
    expect(seen).toEqual(['list installations'])

    seen.length = 0
    const out: ScheduledRepository[] = []
    for await (const target of lister.repositoriesOf(2)) {
      out.push(target)
    }
    expect(out.map(t => `${t.installationId}:${t.repository.full_name}`)).toEqual(['2:globex/core'])
    expect(seen).toEqual(['mint 2', 'list repositories as token tok-2'])
  })
})
