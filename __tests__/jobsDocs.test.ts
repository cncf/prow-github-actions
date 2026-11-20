import { readFileSync } from 'node:fs'
import * as path from 'node:path'
import * as yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'

const root = path.resolve(__dirname, '..')
const cronDoc = 'docs/cron-jobs.md'
const prDoc = 'docs/pr-jobs.md'
const cronDispatcher = 'src/cronJobs/handleCronJob.ts'
const prDispatcher = 'src/pullReq/handlePullReq.ts'

function read(file: string): string {
  return readFileSync(path.join(root, file), 'utf8')
}

// the dispatch arms: `case 'lgtm':`; the empty case is the "no jobs" error, not a job
function switchCases(source: string): string[] {
  return [...source.matchAll(/^\s+case '([a-z-]*)':/gm)].map(m => m[1]).filter(name => name !== '')
}

// the documented jobs: the first cell of every row of the table whose header starts `Jobs | ...`
function tableJobs(doc: string): string[] {
  const lines = doc.split('\n')
  const header = lines.findIndex(line => line.startsWith('Jobs | '))
  expect(header, 'no `Jobs | ...` table').toBeGreaterThan(-1)
  const rows: string[] = []
  for (const line of lines.slice(header + 2)) {
    if (!line.startsWith('`')) {
      break
    }
    rows.push(line.split(' | ')[0])
  }
  return rows.flatMap(cell => [...cell.matchAll(/^`([a-z-]+)`$/g)].map(m => m[1]))
}

const cronSource = read(cronDispatcher)
const prSource = read(prDispatcher)
const cronJobs = switchCases(cronSource)
const prJobs = switchCases(prSource)

const actionInputs = (yaml.load(read('action.yml')) as { inputs: Record<string, { description: string }> }).inputs
// the `jobs` input lists each job in quotes: `'lgtm' (merge lgtm PRs on a schedule, ...)`
const actionJobs = [...actionInputs.jobs.description.matchAll(/'([a-z-]+)' \(/g)].map(m => m[1])

describe(`${cronDoc} agrees with ${cronDispatcher}`, () => {
  it('finds the job arms in the source', () => {
    expect(cronJobs).toEqual(expect.arrayContaining(['lgtm', 'sweep', 'label-sync']))
    expect(new Set(cronJobs).size).toBe(cronJobs.length)
  })

  it('has one table row per job arm and no row for a job the dispatcher lacks', () => {
    expect(tableJobs(read(cronDoc)).sort()).toEqual([...cronJobs].sort())
  })

  it('shows every job in its input example', () => {
    const example = /`jobs: ([a-z\- ]+)`/.exec(read(cronDoc))
    expect(example, `${cronDoc} has no \`jobs: ...\` example`).not.toBeNull()
    expect(example![1].split(' ').sort()).toEqual([...cronJobs].sort())
  })

  it('quotes the failure text of an unknown job as the dispatcher emits it', () => {
    const prefix = /return new Error\(\s*`(could not execute )\$\{command\}/.exec(cronSource)
    expect(prefix).not.toBeNull()
    expect(read(cronDoc)).toContain(`\`${prefix![1]}<job>\``)
  })
})

describe(`${prDoc} agrees with ${prDispatcher}`, () => {
  it('finds the job arms in the source', () => {
    expect(prJobs).toEqual(['lgtm'])
  })

  it('has one table row per job arm and no row for a job the dispatcher lacks', () => {
    expect(tableJobs(read(prDoc)).sort()).toEqual([...prJobs].sort())
  })

  it('names the only activity type the lgtm job acts on', () => {
    const guard = /case 'lgtm':\s+if \(action !== '([a-z_]+)'\)/.exec(prSource)
    expect(guard).not.toBeNull()
    expect(read(prDoc)).toMatch(new RegExp(`^\`lgtm\` \\| \`${guard![1]}\` only \\| `, 'm'))
  })

  it('runs no job the schedule dispatcher does not also know', () => {
    for (const job of prJobs) {
      expect(cronJobs, `${job} is a pull_request job but not a schedule job`).toContain(job)
    }
  })
})

describe('action.yml `jobs` input agrees with the dispatchers', () => {
  it('describes every job arm and no other', () => {
    expect([...actionJobs].sort()).toEqual([...cronJobs].sort())
  })

  it('names the pull_request job as well as the schedule jobs', () => {
    for (const job of prJobs) {
      expect(actionJobs).toContain(job)
    }
  })
})
