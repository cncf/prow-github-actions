import type { Job, Step, Workflow } from './utils/workflowYaml'
import { describe, expect, it } from 'vitest'

import { expression, loadYaml, read } from './utils/workflowYaml'

// release.yml (tag push) and pre-release.yml (manual) are two copies of one pipeline: verify the
// bundle, generate and sign an SBOM, attest provenance, publish a GitHub Release with three
// artifacts. Nothing shares code between them, so every edit to one has to be mirrored by hand;
// this file fails when the copies drift apart, or apart from what docs/releasing.md lists.

const releasePath = '.github/workflows/release.yml'
const preReleasePath = '.github/workflows/pre-release.yml'
const releasingDoc = 'docs/releasing.md'

const release = loadYaml<Workflow>(releasePath)
const preRelease = loadYaml<Workflow>(preReleasePath)

function steps(job: Job): Step[] {
  return job.steps ?? []
}

function runOf(job: Job, name: string): string {
  const found = steps(job).find(s => s.name === name)
  expect(found?.run, `no step named '${name}' with a run:`).toBeDefined()
  return found?.run as string
}

function usesOf(job: Job): string[] {
  return steps(job).flatMap(s => (s.uses ? [s.uses] : []))
}

function releaseStep(job: Job): Step {
  const found = steps(job).find(s => s.uses?.startsWith('softprops/action-gh-release@'))
  expect(found, 'no softprops/action-gh-release step').toBeDefined()
  return found as Step
}

const sharedScripts = ['Install waybill', 'Generate SBOM (SPDX 2.3)', 'Sign SBOM', 'Rename provenance bundle']

describe('release.yml and pre-release.yml are the same pipeline', () => {
  const [r, p] = [release.jobs['github-release'], preRelease.jobs['github-release']]

  it('pin the same waybill version and sha256', () => {
    expect(release.env?.WAYBILL_VERSION).toMatch(/^v\d+\.\d+\.\d+$/)
    expect(release.env?.WAYBILL_SHA256).toMatch(/^[0-9a-f]{64}$/)
    expect(preRelease.env?.WAYBILL_VERSION).toBe(release.env?.WAYBILL_VERSION)
    expect(preRelease.env?.WAYBILL_SHA256).toBe(release.env?.WAYBILL_SHA256)
  })

  it('pin the same action shas in the same order in both jobs', () => {
    expect(usesOf(preRelease.jobs.verify)).toEqual(usesOf(release.jobs.verify))
    expect(usesOf(p)).toEqual(usesOf(r))
  })

  it.each(sharedScripts)('run an identical \'%s\' script', (name) => {
    expect(runOf(p, name)).toBe(runOf(r, name))
  })

  it('attest the same subjects', () => {
    const attest = (job: Job) => steps(job).find(s => s.uses?.startsWith('actions/attest-build-provenance@'))
    expect(attest(p)?.with).toEqual(attest(r)?.with)
  })

  it('run the same verify job, apart from the pre-release input check and the ::error:: wording', () => {
    const strip = (job: Job) => steps(job)
      .filter(s => s.name !== 'Validate version input')
      .map(s => ({ uses: s.uses, with: s.with, run: s.run?.split('\n').filter(line => !line.includes('::error::')).join('\n') }))
    expect(strip(preRelease.jobs.verify)).toEqual(strip(release.jobs.verify))
  })
})

describe.each([
  [releasePath, release],
  [preReleasePath, preRelease],
])('%s', (_file, workflow) => {
  const publish = workflow.jobs['github-release']

  it('reads only at the top level and grants the release job exactly what signing and publishing need', () => {
    expect(workflow.permissions).toEqual({ contents: 'read' })
    expect(workflow.jobs.verify.permissions).toBeUndefined()
    expect(publish.permissions).toEqual({ 'contents': 'write', 'id-token': 'write', 'attestations': 'write' })
  })

  it('checks the waybill sha256 before unpacking the tarball', () => {
    const install = runOf(publish, 'Install waybill')
    expect(install).toContain('sha256sum -c')
    expect(install.indexOf('sha256sum')).toBeLessThan(install.indexOf('tar -xzf'))
  })

  it('attaches exactly the artifacts docs/releasing.md lists', () => {
    const documented = [...read(releasingDoc).matchAll(/`prow-github-actions-<version>([^`]+)`/g)].map(m => m[1])
    expect(documented.length).toBeGreaterThan(0)
    const attached = String(releaseStep(publish).with?.files).trim().split('\n').map(s => s.trim())
    expect(attached).toEqual(documented.map(suffix => `prow-github-actions-${expression('env.VERSION')}${suffix}`))
  })
})

describe('pre-release.yml version input', () => {
  const validate = runOf(preRelease.jobs.verify, 'Validate version input')
  const pattern = /grep -Eq '(\^.*\$)'/.exec(validate)?.[1]

  it('is checked by a grep pattern in the first verify step', () => {
    expect(steps(preRelease.jobs.verify)[0]?.name).toBe('Validate version input')
    expect(pattern, 'no grep -Eq pattern in the validation step').toBeDefined()
  })

  it.each([
    ['2.1.0-rc.1', true],
    ['3.0.0-alpha.0', true],
    ['10.20.30-beta.12', true],
    ['2.1.0', false],
    ['v2.1.0-rc.1', false],
    ['2.1.0-rc', false],
    ['2.1.0-rc.1.2', false],
    ['2.1-rc.1', false],
    ['2.1.0-dev.1', false],
    ['2.1.0-rc.1 ', false],
  ])('%s accepted: %s', (version, accepted) => {
    expect(new RegExp(pattern as string).test(version)).toBe(accepted)
  })
})
