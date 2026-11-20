import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
// the configs are .mjs files outside tsconfig's `include`, so they import as `any`
// @ts-expect-error TS7016
import unit from '../vitest.config.mjs'
// @ts-expect-error TS7016
import e2e from '../vitest.e2e-coverage.config.mjs'

// `npm run test:coverage:e2e` reports what the bundle exercises, remapped onto
// src/. A setup file that imports a src/ module loads a second, vite-transformed
// copy of it into the vitest worker; its V8 hits merge with the bundle's and,
// because the two transforms put a function's declaration on different columns,
// istanbul keeps both entries. Every function the worker loads but never calls
// then counts as uncovered (platform(), actionsContext() and sleep() did, through
// __tests__/setup.ts). The e2e run may install only setup files that import
// nothing from src/.

const root = resolve(__dirname, '..')
const srcImport = /from\s+['"](?:\.\.\/)+src\/|import\(\s*['"](?:\.\.\/)+src\//

function setupFiles(config: { test?: { setupFiles?: string | string[] } }): string[] {
  const files = config.test?.setupFiles
  return typeof files === 'string' ? [files] : (files ?? [])
}

describe('vitest.e2e-coverage.config.mjs setup files', () => {
  it('installs at least the toThrow guard', () => {
    expect(setupFiles(e2e)).toContain('__tests__/setupToThrowGuard.ts')
  })

  it('imports nothing from src/ in any setup file', () => {
    const files = setupFiles(e2e)
    expect(files.length).toBeGreaterThan(0)
    for (const file of files) {
      const source = readFileSync(resolve(root, file), 'utf8')
      expect(source, `${file} imports from src/`).not.toMatch(srcImport)
    }
  })
})

describe('vitest.config.mjs setup files', () => {
  it('still installs the toThrow guard, the @actions/core mock and the platform', () => {
    expect(setupFiles(unit)).toEqual(expect.arrayContaining(['__tests__/setupToThrowGuard.ts', '__tests__/setup.ts']))
  })
})
