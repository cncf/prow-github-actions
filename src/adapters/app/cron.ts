import type { Context, PayloadRepository } from '../../platform'
import type { AppRun, LogSink, TokenSource } from './platform'
import type { AppSettings } from './settings'
import { createAppAuth } from '@octokit/auth-app'
import { Octokit } from '@octokit/rest'

import { runWithPlatform } from '../../platform'
import { appPlatform } from './platform'

export interface ScheduledRepository {
  installationId: number
  repository: PayloadRepository
}

export interface InstallationLister {
  /** every repository the App is installed on, across installations */
  repositories: () => AsyncIterable<ScheduledRepository>
}

export function appInstallationLister(settings: AppSettings, tokens: TokenSource): InstallationLister {
  const asApp = new Octokit({ authStrategy: createAppAuth, auth: { appId: settings.appId, privateKey: settings.privateKey }, baseUrl: settings.apiBaseUrl })
  return {
    async* repositories() {
      const installations = await asApp.paginate(asApp.apps.listInstallations, { per_page: 100 })
      for (const installation of installations) {
        if (installation.suspended_at) {
          continue
        }
        const token = await tokens.installationToken(installation.id)
        const asInstallation = new Octokit({ auth: token, baseUrl: settings.apiBaseUrl })
        const repositories = await asInstallation.paginate(asInstallation.apps.listReposAccessibleToInstallation, { per_page: 100 })
        for (const repository of repositories) {
          if (repository.archived) {
            continue
          }
          yield { installationId: installation.id, repository: repository as unknown as PayloadRepository }
        }
      }
    },
  }
}

export interface Scheduler {
  settings: AppSettings
  tokens: TokenSource
  installations: InstallationLister
  sink: LogSink
  /** `handleCronJobs` in production */
  dispatch: (context: Context) => Promise<void>
  /** repositories handled at once; default 4 */
  concurrency?: number
}

export interface ScheduledRunReport {
  repositories: number
  /** `owner/repo` of every run whose platform recorded a failure, or which threw */
  failed: string[]
}

export function scheduleContext(target: ScheduledRepository): Context['payload'] {
  return { repository: target.repository, installation: { id: target.installationId } }
}

/**
 * runScheduledJobs runs the cron jobs once for every repository the App is
 * installed on, each under its own platform and token, a few at a time. One
 * repository's failure is reported and never stops the others.
 */
export async function runScheduledJobs(scheduler: Scheduler): Promise<ScheduledRunReport> {
  const report: ScheduledRunReport = { repositories: 0, failed: [] }
  const limit = scheduler.concurrency ?? 4
  const inFlight = new Set<Promise<void>>()

  const runOne = async (target: ScheduledRepository): Promise<void> => {
    const name = `${target.repository.owner.login}/${target.repository.name}`
    report.repositories++
    const delivery = { id: `schedule-${Date.now()}-${name}`, eventName: 'schedule', payload: scheduleContext(target) }
    let run: AppRun
    try {
      run = appPlatform(scheduler.settings, scheduler.tokens, delivery, scheduler.sink)
      await run.resolveToken()
      await runWithPlatform(run.platform, () => scheduler.dispatch(run.platform.context()))
    }
    catch (error) {
      scheduler.sink({ level: 'error', event: 'schedule', repo: name, message: error instanceof Error ? error.message : String(error) })
      report.failed.push(name)
      return
    }
    if (run.failures.length > 0) {
      report.failed.push(name)
    }
  }

  for await (const target of scheduler.installations.repositories()) {
    const task = runOne(target).finally(() => inFlight.delete(task))
    inFlight.add(task)
    if (inFlight.size >= limit) {
      await Promise.race(inFlight)
    }
  }
  await Promise.all(inFlight)
  scheduler.sink({ level: 'info', event: 'schedule', message: `scheduled jobs ran for ${report.repositories} repositories, ${report.failed.length} failed` })
  return report
}
