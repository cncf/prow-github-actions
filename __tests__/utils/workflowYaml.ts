import { readFileSync } from 'node:fs'
import * as path from 'node:path'
import * as yaml from 'js-yaml'

// the shape of a GitHub Actions workflow as the workflow tests read it, and the readers they share

export const root = path.resolve(__dirname, '..', '..')

export type Mapping = Record<string, unknown>
export interface Step { name?: string, id?: string, if?: string, uses?: string, with?: Mapping, run?: string, env?: Mapping }
export interface Job { name?: string, needs?: string, if?: string, uses?: string, with?: Mapping, permissions?: Mapping, env?: Mapping, steps?: Step[] }
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
