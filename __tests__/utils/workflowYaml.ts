import { readFileSync } from 'node:fs'
import * as path from 'node:path'
import * as yaml from 'js-yaml'
import { treeRoot } from '../treeRoot'

// the shape of a GitHub Actions workflow as the workflow tests read it, and the readers they share

// the tree's copy: workflows.test.ts scans src/ for the inputs it reads and worker/entryPoints.test.ts
// scans src/server/worker.ts for its entry points, and a Stryker sandbox holds instrumented ones
// (`getInput(stryMutAct_9fa48("1") ? "" : (stryCov_9fa48("1"), 'cat-api-key'))`) the patterns cannot read
export const root = treeRoot(path.resolve(__dirname, '..'))

export type Mapping = Record<string, unknown>
export interface Step { name?: string, id?: string, if?: string, uses?: string, with?: Mapping, run?: string, env?: Mapping }
export interface Job { name?: string, needs?: string, if?: string, uses?: string, with?: Mapping, permissions?: Mapping, env?: Mapping, outputs?: Mapping, steps?: Step[] }
export interface Workflow {
  on: Mapping
  permissions?: Mapping
  concurrency?: Mapping
  env?: Mapping
  jobs: Record<string, Job>
}

/** `${{ inner }}`, an Actions expression */
export function expression(inner: string): string {
  return `$\{{ ${inner} }}`
}

export function read(file: string): string {
  return readFileSync(path.join(root, file), 'utf8')
}

export function loadYaml<T>(file: string): T {
  return yaml.load(read(file)) as T
}
