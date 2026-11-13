import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as path from 'node:path'

import { afterEach, describe, expect, it } from 'vitest'
import { root } from './utils/workflowYaml'

// `npm run test:coverage:e2e` reports the bundle suite's hits against src/ through
// .coverage-bundle/index.js.map, after __tests__/bundle/coverageEntry/remap.mjs has
// composed tsc's per-file column mappings into ncc's line-only map. The 99 %
// e2e floor in vitest.e2e-coverage.config.mjs reads that composed map, so a
// codec or pairing slip there would move hits between lines without failing
// anything. The script has no exports; this drives it as the build does, on
// maps small enough to write by hand, and reads the result back with an
// independent decoder.

const remap = path.join(root, '__tests__', 'bundle', 'coverageEntry', 'remap.mjs')

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

type Segment = number[]
type Lines = Segment[][]

function encodeVlq(value: number): string {
  let vlq = value < 0 ? (-value << 1) | 1 : value << 1
  let out = ''
  do {
    let digit = vlq & 31
    vlq >>>= 5
    if (vlq > 0)
      digit |= 32
    out += BASE64[digit]
  } while (vlq > 0)
  return out
}

// Absolute segments ([genCol, source, origLine, origCol]) to a `mappings` string.
function encode(lines: Lines): string {
  const state = [0, 0, 0, 0]
  return lines
    .map((segs) => {
      let genCol = 0
      return segs
        .map((seg) => {
          let out = encodeVlq(seg[0] - genCol)
          genCol = seg[0]
          for (let f = 1; f < seg.length; f++) {
            out += encodeVlq(seg[f] - state[f - 1])
            state[f - 1] = seg[f]
          }
          return out
        })
        .join(',')
    })
    .join(';')
}

// A `mappings` string back to absolute segments.
function decode(mappings: string): Lines {
  const state = [0, 0, 0, 0]
  return mappings.split(';').map((line) => {
    let genCol = 0
    if (line === '')
      return []
    return line.split(',').map((segment) => {
      const fields: number[] = []
      let i = 0
      while (i < segment.length) {
        let value = 0
        let shift = 0
        let digit: number
        do {
          digit = BASE64.indexOf(segment[i++])
          value += (digit & 31) << shift
          shift += 5
        } while (digit & 32)
        fields.push(value & 1 ? -(value >>> 1) : value >>> 1)
      }
      genCol += fields[0]
      const seg = [genCol]
      for (let f = 1; f < fields.length; f++) {
        state[f - 1] += fields[f]
        seg.push(state[f - 1])
      }
      return seg
    })
  })
}

interface Fixture {
  sources: string[]
  bundle: Lines
  tsc: Record<string, Lines>
}

const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function run(fixture: Fixture): { lines: Lines, mappings: string, stderr: string, mapPath: string } {
  const dir = mkdtempSync(path.join(tmpdir(), 'coverage-remap-'))
  dirs.push(dir)
  const mapPath = path.join(dir, 'index.js.map')
  writeFileSync(mapPath, JSON.stringify({ version: 3, sources: fixture.sources, names: [], mappings: encode(fixture.bundle) }))
  for (const [module, lines] of Object.entries(fixture.tsc)) {
    const tscMap = path.join(dir, 'tsc', `${module}.js.map`)
    mkdirSync(path.dirname(tscMap), { recursive: true })
    writeFileSync(tscMap, JSON.stringify({ version: 3, sources: [`${module}.ts`], names: [], mappings: encode(lines) }))
  }
  // the script reports on stderr only, which execFileSync discards on success
  const stderr = execFileSync('bash', ['-c', '"$0" "$1" "$2" 2>&1 >/dev/null', process.execPath, remap, dir], { cwd: root, stdio: 'pipe' }).toString()
  const map = JSON.parse(readFileSync(mapPath, 'utf8')) as { mappings: string }
  return { lines: decode(map.mappings), mappings: map.mappings, stderr, mapPath }
}

const fooSource = 'webpack://prow-github-actions/./src/foo.ts'

describe('coverageEntry/remap.mjs', () => {
  it('round-trips the codec used to write the fixtures', () => {
    const lines: Lines = [[], [[0, 0, 0, 0]], [[0, 0, 2, 0], [4, 0, 3, 2], [10, 0, 4, 4]], [[0, 1, 0, 0], [7, 0, 5, 1]]]
    expect(decode(encode(lines))).toEqual(lines)
    expect(encode([[[0, 0, 0, 0]]])).toBe('AAAA')
    expect(encode([[[0, 0, 2, 0], [4, 0, 3, 2], [10, 0, 4, 4]]])).toBe('AAEA,IACE,MACE')
  })

  it('replaces a bundle line\'s single segment with the tsc line\'s columns for the same source line', () => {
    // src/foo.ts lines 2-4 are one JS line in both outputs; the bundle has a preamble line first.
    const tscFoo: Lines = [[[0, 0, 0, 0]], [[0, 0, 2, 0], [4, 0, 3, 2], [10, 0, 4, 4]]]
    const { lines } = run({
      sources: [fooSource],
      bundle: [[], [[0, 0, 0, 0]], [[0, 0, 2, 0]]],
      tsc: { 'src/foo': tscFoo },
    })
    expect(lines).toEqual([[], [[0, 0, 0, 0]], [[0, 0, 2, 0], [4, 0, 3, 2], [10, 0, 4, 4]]])
  })

  it('keeps the other sources\' segments on a shared bundle line and sorts by column', () => {
    // webpack concatenated a dependency after foo on one line; the dependency's
    // segment (column 20) must survive and sit after foo's composed columns
    const { lines } = run({
      sources: ['webpack://prow-github-actions/./node_modules/dep/index.js', fooSource],
      bundle: [[[0, 1, 0, 0], [20, 0, 0, 0]]],
      tsc: { 'src/foo': [[[0, 0, 0, 0], [8, 0, 0, 6]]] },
    })
    expect(lines).toEqual([[[0, 1, 0, 0], [8, 1, 0, 6], [20, 0, 0, 0]]])
  })

  it('tolerates up to three tsc lines that webpack hoisted onto the previous bundle line', () => {
    // tsc lines 1-3 (source lines 1-3) are absent from the bundle; line 4 must still pair.
    const tscFoo: Lines = [[[0, 0, 0, 0]], [[0, 0, 1, 0]], [[0, 0, 2, 0]], [[0, 0, 3, 0]], [[0, 0, 4, 0], [6, 0, 4, 9]]]
    const { lines } = run({
      sources: [fooSource],
      bundle: [[[0, 0, 0, 0]], [[0, 0, 4, 0]]],
      tsc: { 'src/foo': tscFoo },
    })
    expect(lines).toEqual([[[0, 0, 0, 0]], [[0, 0, 4, 0], [6, 0, 4, 9]]])
  })

  it('keeps the line-only map when a bundle line has no tsc line within the lookahead', () => {
    // five intervening tsc lines exceed the lookahead, so pairing fails and nothing changes
    const tscFoo: Lines = [[[0, 0, 0, 0]], [[0, 0, 1, 0]], [[0, 0, 2, 0]], [[0, 0, 3, 0]], [[0, 0, 4, 0]], [[0, 0, 5, 0], [6, 0, 5, 9]]]
    const bundle: Lines = [[[0, 0, 0, 0]], [[0, 0, 5, 0]]]
    const { lines, stderr } = run({ sources: [fooSource], bundle, tsc: { 'src/foo': tscFoo } })
    expect(lines).toEqual(bundle)
    expect(stderr).toContain('remap: kept line-only mappings for src/foo (lines do not pair)')
  })

  it('keeps the line-only map and says so when tsc emitted no map for the module', () => {
    const bundle: Lines = [[[0, 0, 0, 0]], [[0, 0, 1, 0]]]
    const { lines, stderr } = run({ sources: [fooSource], bundle, tsc: {} })
    expect(lines).toEqual(bundle)
    expect(stderr).toContain('remap: kept line-only mappings for src/foo (no tsc map)')
  })

  it('leaves sources outside src/ alone and counts only composed modules', () => {
    const bundle: Lines = [[[0, 0, 0, 0]], [[0, 1, 0, 0]]]
    const { lines, stderr, mapPath } = run({
      sources: ['webpack://prow-github-actions/./node_modules/dep/index.js', fooSource],
      bundle,
      tsc: { 'node_modules/dep/index': [[[0, 0, 0, 0], [3, 0, 0, 3]]], 'src/foo': [[[0, 0, 0, 0], [5, 0, 0, 5]]] },
    })
    expect(lines).toEqual([[[0, 0, 0, 0]], [[0, 1, 0, 0], [5, 1, 0, 5]]])
    expect(stderr).toBe(`remap: composed column mappings for 1 src/ modules in ${mapPath}\n`)
  })

  it('encodes negative deltas when a later line maps an earlier source line', () => {
    // src/foo.ts line 3 is emitted before line 1 (a hoisted helper); the tsc map
    // carries the backwards jump and the composed map must preserve it.
    const tscFoo: Lines = [[[0, 0, 3, 0], [4, 0, 3, 7]], [[0, 0, 1, 0], [2, 0, 1, 12]]]
    const { lines, mappings } = run({
      sources: [fooSource],
      bundle: [[[0, 0, 3, 0]], [[0, 0, 1, 0]]],
      tsc: { 'src/foo': tscFoo },
    })
    expect(lines).toEqual(tscFoo)
    expect(mappings).toBe('AAGA,IAAO;AAFP,EAAY')
  })
})
