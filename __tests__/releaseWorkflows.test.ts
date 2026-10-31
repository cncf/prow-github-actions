import type { Job, Step, Workflow } from './utils/workflowYaml'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
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

describe.each([
  [releasePath, release],
  [preReleasePath, preRelease],
])('%s publishes the App image and chart', (_file, workflow) => {
  const image = workflow.jobs.image
  const chart = workflow.jobs.chart
  const publishPermissions = { 'contents': 'read', 'packages': 'write', 'id-token': 'write', 'attestations': 'write' }

  it('runs image after verify, chart after image, and the release after all three', () => {
    expect(image.needs).toBe('verify')
    expect(chart.needs).toBe('image')
    expect(workflow.jobs['github-release'].needs).toEqual(['verify', 'image', 'chart'])
  })

  it('grants both publishing jobs exactly what pushing, signing and attesting need', () => {
    expect(image.permissions).toEqual(publishPermissions)
    expect(chart.permissions).toEqual(publishPermissions)
  })

  it('builds for amd64 and arm64 and pushes to ghcr.io under the repository', () => {
    const build = steps(image).find(s => s.uses?.startsWith('docker/build-push-action@'))
    expect(build?.with).toMatchObject({ platforms: 'linux/amd64,linux/arm64', push: true })
    const meta = steps(image).find(s => s.uses?.startsWith('docker/metadata-action@'))
    expect(meta?.with?.images).toBe(`ghcr.io/${expression('github.repository')}`)
    const login = steps(image).find(s => s.uses?.startsWith('docker/login-action@'))
    expect(login?.with).toMatchObject({ registry: 'ghcr.io', password: expression('secrets.GITHUB_TOKEN') })
  })

  it('signs and attests the image by the digest the build produced', () => {
    const digest = expression('steps.build.outputs.digest')
    expect(runOf(image, 'Sign image')).toContain(`@${digest}`)
    const attest = steps(image).find(s => s.uses?.startsWith('actions/attest-build-provenance@'))
    expect(attest?.with).toEqual({ 'subject-name': `ghcr.io/${expression('github.repository')}`, 'subject-digest': digest, 'push-to-registry': true })
  })

  it('packages the chart at the release version, pushes it under <repository>/charts, then signs and attests that digest', () => {
    const push = runOf(chart, 'Package and push chart')
    expect(push).toContain('helm package charts/prow-github-app --version "$VERSION" --app-version "$VERSION"')
    expect(push).toContain(`oci://ghcr.io/${expression('github.repository')}/charts`)
    expect(push).toMatch(/sha256:\[a-f0-9\]\{64\}/)
    const digest = expression('steps.push.outputs.digest')
    expect(runOf(chart, 'Sign chart')).toContain(`charts/prow-github-app@${digest}`)
    const attest = steps(chart).find(s => s.uses?.startsWith('actions/attest-build-provenance@'))
    expect(attest?.with).toEqual({ 'subject-name': `ghcr.io/${expression('github.repository')}/charts/prow-github-app`, 'subject-digest': digest, 'push-to-registry': true })
  })

  it('pins every action by sha', () => {
    for (const uses of [...usesOf(image), ...usesOf(chart)]) {
      expect(uses, uses).toMatch(/@[0-9a-f]{40}$/)
    }
  })
})

describe('image tags', () => {
  const tagsOf = (workflow: Workflow) => String(steps(workflow.jobs.image).find(s => s.uses?.startsWith('docker/metadata-action@'))?.with?.tags)

  it('a release gets its version, and each floating tag only when it is the highest stable release that tag covers', () => {
    const tags = tagsOf(release)
    expect(tags).toContain('type=semver,pattern={{version}}')
    const gate = (output: string) => `enable=${expression(`steps.order.outputs.${output} == 'true'`)}`
    expect(tags).toContain(`type=semver,pattern={{major}}.{{minor}},${gate('minor')}`)
    expect(tags).toContain(`type=semver,pattern={{major}},${gate('major')}`)
    expect(tags).toContain(`type=raw,value=latest,${gate('latest')}`)
  })

  it('a pre-release gets only its own version', () => {
    expect(tagsOf(preRelease).trim()).toBe(`type=raw,value=${expression('inputs.version')}`)
  })
})

describe('release.yml floating tags', () => {
  const image = release.jobs.image
  const order = runOf(image, 'Compare with the released tags')
  const gitEnv = {
    ...process.env,
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_AUTHOR_NAME: 'release',
    GIT_AUTHOR_EMAIL: 'release@example.com',
    GIT_COMMITTER_NAME: 'release',
    GIT_COMMITTER_EMAIL: 'release@example.com',
  }

  // runs the step's script in a repository carrying `tags`, as the tag push of `ref` would
  function compare(tags: string[], ref: string): Record<string, string> {
    const dir = mkdtempSync(path.join(tmpdir(), 'release-order-'))
    try {
      const git = (...args: string[]) => execFileSync('git', args, { cwd: dir, env: gitEnv, stdio: 'pipe' })
      git('init', '-q')
      git('commit', '-q', '--allow-empty', '-m', 'release')
      for (const tag of [...tags, ref]) {
        git('tag', tag)
      }
      const output = path.join(dir, 'github-output')
      execFileSync('bash', ['-e', '-c', order], { cwd: dir, env: { ...gitEnv, GITHUB_REF_NAME: ref, GITHUB_OUTPUT: output }, stdio: 'pipe' })
      return Object.fromEntries(readFileSync(output, 'utf8').trim().split('\n').map(line => line.split('=')))
    }
    finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  it.each([
    ['the newest release moves every floating tag', ['v3', 'v3.3.1'], 'v3.4.0', { latest: 'true', major: 'true', minor: 'true' }],
    ['a backport to an older minor moves only its minor', ['v3', 'v3.3.1', 'v3.4.0'], 'v3.3.2', { latest: 'false', major: 'false', minor: 'true' }],
    ['a backport to an older major moves its major and minor, not latest', ['v2.9.0', 'v3.4.0'], 'v2.9.1', { latest: 'false', major: 'true', minor: 'true' }],
    ['an older patch moves nothing', ['v3.4.1'], 'v3.4.0', { latest: 'false', major: 'false', minor: 'false' }],
    ['a pre-release moves nothing, even above every release', ['v3.4.0'], 'v3.5.0-rc.1', { latest: 'false', major: 'false', minor: 'false' }],
    ['releases compare as versions, not as strings', ['v3.9.0', 'v3.10.0-rc.1'], 'v3.10.0', { latest: 'true', major: 'true', minor: 'true' }],
  ])('%s', (_name, tags, ref, expected) => {
    expect(compare(tags, ref)).toEqual(expected)
  })

  it('checks out every tag for the comparison', () => {
    expect(steps(image)[0]?.with).toEqual({ 'fetch-depth': 0 })
  })

  it('moves the floating major git tag and marks the GitHub release latest only by the comparison', () => {
    expect(image.outputs).toMatchObject({ latest: expression('steps.order.outputs.latest'), major: expression('steps.order.outputs.major') })
    const publish = release.jobs['github-release']
    expect(steps(publish).find(s => s.name === 'Update floating major tag')?.if).toBe(expression('needs.image.outputs.major == \'true\''))
    expect(releaseStep(publish).with?.make_latest).toBe(expression('needs.image.outputs.latest'))
  })
})
