import { readdirSync, readFileSync } from 'node:fs'
import * as path from 'node:path'
import * as yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'

const root = path.resolve(__dirname, '..')
const read = (file: string) => readFileSync(path.join(root, file), 'utf8')

interface ActionManifest { runs: { using: string, main: string } }
interface DevRuntime { name?: string, version?: string, onFail?: string }
interface PackageManifest {
  engines?: Record<string, string>
  devEngines?: { runtime?: DevRuntime | DevRuntime[] }
  devDependencies?: Record<string, string>
}
interface Step { uses?: string, with?: Record<string, unknown> }
interface Workflow { jobs: Record<string, { steps?: Step[] }> }

const action = yaml.load(read('action.yml')) as ActionManifest
const pkg = JSON.parse(read('package.json')) as PackageManifest

// `runs.using: node24` is the runtime GitHub starts dist/index.js under; every other Node
// version in the repository must name the same major or the bundle is built and tested
// against a runtime the action never sees.
const runtimeMajor = Number(/^node(\d+)$/.exec(action.runs.using)?.[1])

describe(`action.yml runs the bundle under ${action.runs.using}`, () => {
  it('names a versioned node runtime', () => {
    expect(action.runs.using).toMatch(/^node\d+$/)
    expect(Number.isInteger(runtimeMajor)).toBe(true)
  })

  it('points main at the committed bundle', () => {
    expect(action.runs.main).toBe('dist/index.js')
  })

  it('is the floor of package.json engines.node', () => {
    expect(pkg.engines?.node).toBe(`>=${runtimeMajor}`)
  })

  // setup-node reads devEngines.runtime before engines.node and resolves a range to the
  // highest Node in the runner's tool cache that satisfies it, so the open `>=` floor alone
  // would move every CI job and the release build to the next major the day the hosted
  // image ships it. The bare major keeps CI on the runtime's line while still tracking
  // its patch releases.
  describe('is the only major package.json devEngines.runtime lets a setup-node step resolve', () => {
    const runtimes = [pkg.devEngines?.runtime].flat()
    const node = runtimes.find(runtime => runtime?.name === 'node')

    it('names a node runtime', () => {
      expect(node).toBeDefined()
    })

    it(`pins the bare major ${runtimeMajor}, not a range that admits a newer one`, () => {
      expect(node?.version).toBe(String(runtimeMajor))
    })

    it('only warns a contributor on a newer Node, as docs/contributing.md allows "Node 24 or newer"', () => {
      expect(node?.onFail).toBe('warn')
      expect(read('docs/contributing.md')).toContain(`Node ${runtimeMajor} or newer is required.`)
    })
  })

  it('is the major of the @types/node the sources compile against', () => {
    expect(pkg.devDependencies?.['@types/node']).toBe(`^${runtimeMajor}`)
  })

  it('is the runtime the README tells self-hosted runner operators to provide', () => {
    expect(read('README.md')).toContain(`\`${action.runs.using}\` runtime`)
  })
})

describe('every setup-node step follows package.json', () => {
  const workflows = readdirSync(path.join(root, '.github/workflows')).filter(file => /\.ya?ml$/.test(file))
  const setupNodeSteps = workflows.flatMap((file) => {
    const workflow = yaml.load(read(`.github/workflows/${file}`)) as Workflow
    return Object.entries(workflow.jobs).flatMap(([job, { steps = [] }]) =>
      steps.filter(step => step.uses?.startsWith('actions/setup-node@')).map(step => ({ file, job, step })))
  })

  it('finds the steps that build and test the bundle', () => {
    expect(setupNodeSteps.map(({ file }) => file)).toEqual(expect.arrayContaining(['test.yml', 'release.yml', 'pre-release.yml']))
  })

  it.each(setupNodeSteps.map(({ file, job, step }) => [`${file} ${job}`, step] as const))(
    '%s reads node-version-file: package.json and never pins node-version by hand',
    (_name, step) => {
      expect(step.with?.['node-version-file']).toBe('package.json')
      expect(step.with).not.toHaveProperty('node-version')
    },
  )
})
