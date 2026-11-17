import * as path from 'node:path'
import { describe, expect, it } from 'vitest'

import { treeRoot } from './treeRoot'

describe('treeRoot', () => {
  it('is the parent of __tests__ when the suite runs from the tree', () => {
    expect(treeRoot('/work/prow-github-actions/__tests__')).toBe('/work/prow-github-actions')
    expect(treeRoot(__dirname)).toBe(path.resolve(__dirname, '..'))
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
