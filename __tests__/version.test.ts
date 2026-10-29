import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'

const root = path.resolve(__dirname, '..')
const { version } = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8')) as { version: string }

const reference = /cncf\/prow-github-actions(?:\/\.github\/workflows\/prow\.yml)?@(v[\w.-]+)/g
const floatingMajor = /^v\d+$/
const placeholder = 'vX.Y.Z'

function referencesIn(text: string): string[] {
  return [...text.matchAll(reference)].map(match => match[1].replace(/\.$/, ''))
}

function walk(dir: string): string[] {
  const full = path.join(root, dir)
  if (!existsSync(full)) {
    return []
  }
  return readdirSync(full).flatMap((entry) => {
    const rel = path.posix.join(dir, entry)
    return statSync(path.join(root, rel)).isDirectory() ? walk(rel) : [rel]
  })
}

// past release notes pin the version they announced; only the current release's notes must exist
const files = [
  'README.md',
  ...walk('docs').filter(file => file.endsWith('.md') && !file.startsWith('docs/releases/')),
  ...walk('templates'),
  '.github/workflows/prow.yml',
  '.github/workflows/prow-bot.yml',
]

describe(`every pinned reference agrees with package.json (${version})`, () => {
  it('reads a semver version from package.json', () => {
    expect(version).toMatch(/^\d+\.\d+\.\d+(?:-[\w.]+)?$/)
  })

  it.each(files)('%s', (file) => {
    const refs = referencesIn(readFileSync(path.join(root, file), 'utf8'))
    for (const ref of refs) {
      if (floatingMajor.test(ref) || ref === placeholder) {
        continue
      }
      expect(ref, `${file}: ${ref}`).toBe(`v${version}`)
    }
  })

  it('finds at least one exact reference in the templates', () => {
    const refs = walk('templates').flatMap(file => referencesIn(readFileSync(path.join(root, file), 'utf8')))
    expect(refs).toContain(`v${version}`)
  })

  it(`ships curated release notes in docs/releases/v${version}.md`, () => {
    expect(existsSync(path.join(root, 'docs', 'releases', `v${version}.md`))).toBe(true)
  })

  // release.yml pastes the notes into the GitHub release, where a relative link resolves
  // against github.com/<owner>/<repo>/releases/ and breaks (v3.2.0 shipped three such links)
  it.each(readdirSync(path.join(root, 'docs', 'releases')).filter(file => file.endsWith('.md')))('%s links with absolute urls only', (file) => {
    const notes = readFileSync(path.join(root, 'docs', 'releases', file), 'utf8')
    const relative = [...notes.matchAll(/\]\(((?!https?:\/\/|#)[^)]+)\)/g)].map(match => match[1])
    expect(relative).toEqual([])
  })
})
