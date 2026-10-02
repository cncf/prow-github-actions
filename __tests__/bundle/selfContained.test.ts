import fs from 'node:fs'
import { isBuiltin } from 'node:module'
import { describe, expect, it } from 'vitest'

import { bundlePath } from './runBundle'

// action.yml runs dist/index.js on a runner that never installs node_modules, so every package the
// action imports has to be inlined by ncc. The bundle suite cannot catch a leak: it spawns the bundle
// from the repository root, where node_modules resolves the import anyway.
describe('dist/index.js is self-contained', () => {
  const source = fs.readFileSync(bundlePath, 'utf8')
  const specifiers = [...source.matchAll(/\brequire\((["'])([^"']+)\1\)/g)].map(match => match[2])

  it('requires only node built-in modules', () => {
    expect(specifiers.length).toBeGreaterThan(0)
    expect(specifiers.filter(specifier => !isBuiltin(specifier))).toEqual([])
  })

  it('inlines every package src/ imports', () => {
    const packages = new Set<string>()
    for (const file of fs.readdirSync('src', { recursive: true, encoding: 'utf8' }).filter(name => name.endsWith('.ts'))) {
      for (const match of fs.readFileSync(`src/${file}`, 'utf8').matchAll(/^import .* from '([^'.][^']*)'/gm)) {
        if (!isBuiltin(match[1])) {
          packages.add(match[1])
        }
      }
    }
    expect([...packages]).toEqual(expect.arrayContaining(['@actions/core', '@actions/github', 'js-yaml']))
    for (const name of packages) {
      expect(source, name).toContain(`node_modules/${name}/`)
    }
  })
})
