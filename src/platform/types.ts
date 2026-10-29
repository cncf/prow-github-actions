// the same loose shape @actions/github's WebhookPayload has, owned here so the
// handlers do not import from @actions/*
export interface PayloadRepository {
  [key: string]: any
  full_name?: string
  name: string
  owner: {
    [key: string]: any
    login: string
    name?: string
  }
  html_url?: string
}

export interface WebhookPayload {
  [key: string]: any
  repository?: PayloadRepository
  issue?: {
    [key: string]: any
    number: number
    html_url?: string
    body?: string
  }
  pull_request?: {
    [key: string]: any
    number: number
    html_url?: string
    body?: string
  }
  sender?: {
    [key: string]: any
    type: string
  }
  action?: string
  installation?: {
    id: number
    [key: string]: any
  }
  comment?: {
    id: number
    [key: string]: any
  }
}

/**
 * Context is the event being handled: the GitHub event name, its webhook
 * payload and the repository it concerns. Handlers read nothing else from the
 * runtime, so every adapter (GitHub Actions today) builds one of these from
 * whatever it receives.
 */
export interface Context {
  eventName: string
  payload: WebhookPayload
  repo: { owner: string, repo: string }
}

/** the configuration inputs a handler may ask for; `action.yml` lists the same seven */
export type InputName
  = | 'github-token'
    | 'prow-commands'
    | 'jobs'
    | 'dry-run'
    | 'merge-method'
    | 'config'
    | 'cat-api-key'

export interface Inputs {
  /** returns the trimmed value, '' when unset; with `required` throws when unset */
  get: (name: InputName, options?: { required?: boolean }) => string
}

export interface Logger {
  debug: (message: string) => void
  info: (message: string) => void
  /** a message surfaced prominently by the runtime, e.g. an annotation on Actions */
  notice: (message: string) => void
  warning: (message: string) => void
  error: (message: string) => void
  /** asks the runtime to redact the value from its logs */
  setSecret: (value: string) => void
}

/**
 * RunState is everything a handler memoizes for the duration of one event:
 * configuration, repository labels, OWNERS trees and the warnings already
 * shown. An adapter creates one per event so that nothing leaks across events
 * or repositories in a long-lived process. Values are `unknown`-typed promises
 * on purpose: the owning module casts, and this file imports nothing from it.
 */
export interface RunState {
  configs: Map<string, Promise<unknown>>
  repoLabels: Map<string, Promise<string[]>>
  ownerGroups: Map<string, Promise<string[]>>
  ownerWarnings: Set<string>
  trees: Map<string, Promise<unknown>>
  hasOwners: Map<string, Promise<boolean>>
  pullRequestOwners: Map<string, Promise<unknown>>
  pullRequestTips: Map<string, Promise<string>>
  tideEvaluated: Set<number>
  warned: Set<'merge-queue-unavailable' | 'merge-method-ignored'>
}

export function newRunState(): RunState {
  return {
    configs: new Map(),
    repoLabels: new Map(),
    ownerGroups: new Map(),
    ownerWarnings: new Set(),
    trees: new Map(),
    hasOwners: new Map(),
    pullRequestOwners: new Map(),
    pullRequestTips: new Map(),
    tideEvaluated: new Set(),
    warned: new Set(),
  }
}

/**
 * Platform is everything a handler needs from the runtime it runs on. The
 * GitHub Actions adapter backs it with `@actions/core`, `@actions/github` and
 * the runner's `GITHUB_*` environment.
 */
export interface Platform {
  inputs: Inputs
  log: Logger
  /** the event this run handles */
  context: () => Context
  /** the REST API root; differs on GitHub Enterprise Server */
  apiBaseUrl: () => string
  /** the name of the workflow currently running, when the runtime has one */
  currentWorkflowName: () => string | undefined
  /** marks the run as failed with the given message */
  fail: (message: string) => void
  /** the memoized state of the event being handled */
  state: () => RunState
}
