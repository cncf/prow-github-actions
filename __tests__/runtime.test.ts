import { readdirSync, readFileSync } from 'node:fs'
import * as path from 'node:path'
import * as yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'

const root = path.resolve(__dirname, '..')
const read = (file: string) => readFileSync(path.join(root, file), 'utf8')

interface ActionManifest { runs: { using: string, main: string } }
interface PackageManifest { engines?: Record<string, string>, devDependencies?: Record<string, string> }
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
