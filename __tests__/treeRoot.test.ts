import { existsSync } from 'node:fs'
import * as path from 'node:path'
import { describe, expect, it } from 'vitest'

import { treeRoot } from './treeRoot'

describe('treeRoot', () => {
  it('is the parent of __tests__ when the suite runs from the tree', () => {
    expect(treeRoot('/work/prow-github-actions/__tests__')).toBe('/work/prow-github-actions')
  })

  // Stryker's vitest runner only runs the test files that import a mutated file, and
  // `__tests__/setup.ts` imports `src/adapters/actions.ts` and `src/platform/index.ts`, so a
  // `--mutate` over either of those relates every test file, this one included, and it runs from
  // `<root>/.stryker-tmp/sandbox-<id>/__tests__`. The result for the suite's own `__dirname` is
  // therefore pinned by what it must hold, not by the parent directory, which is only right in
  // the tree.
  it('resolves its own __dirname to the tree, from the tree and from a sandbox copy alike', () => {
    const root = treeRoot(__dirname)
    expect(root).not.toMatch(/\.stryker-tmp/)
    expect(existsSync(path.join(root, 'package.json'))).toBe(true)
    expect(existsSync(path.join(root, '__tests__', 'treeRoot.ts'))).toBe(true)
    expect(path.relative(root, __dirname).split(path.sep)).toContain('__tests__')
  })

  it('is the tree, not the sandbox, when the suite runs from a Stryker sandbox copy', () => {
    expect(treeRoot('/work/prow-github-actions/.stryker-tmp/sandbox-BVP7if/__tests__')).toBe('/work/prow-github-actions')
    expect(treeRoot('C:\\work\\prow\\.stryker-tmp\\sandbox-qBaoRb\\__tests__')).toBe('C:\\work\\prow')
  })

  it('leaves a tree whose own name starts with sandbox- or contains .stryker-tmp elsewhere alone', () => {
    expect(treeRoot('/work/sandbox-labs/__tests__')).toBe('/work/sandbox-labs')
    expect(treeRoot('/work/.stryker-tmp-archive/prow/__tests__')).toBe('/work/.stryker-tmp-archive/prow')
  })
})
