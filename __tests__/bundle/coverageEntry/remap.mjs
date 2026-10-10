// Second step of `npm run pack:coverage`: give .coverage-bundle/index.js.map columns.
//
// ncc builds the coverage bundle with webpack's `cheap-module-source-map`, which
// keeps one mapping per output line at column 0. tsc emits a multi-line TypeScript
// expression (an arrow body inside a `.flatMap(` call, the callback of
// `Object.fromEntries(Object.entries(...).map(...))`, a memoized async callback)
// as a single line of JavaScript, so with a line-only map every node on that
// bundle line is attributed to the expression's first source line and the inner
// lines report 0 hits that the bundle suite did in fact execute.
//
// tsc's own per-file maps (emitted into .coverage-bundle/tsc by the same
// tsconfig) do carry columns, and webpack leaves each module's line structure
// intact apart from scope-hoisting rewrites, so the two maps can be composed:
// pair each bundle line with the tsc output line that maps to the same source
// line, then replace the bundle line's single segment with that tsc line's
// segments. Modules whose lines cannot be paired keep their line-only segments
// and are reported on stderr, so the result is never worse than the input.
import fs from 'node:fs'
import path from 'node:path'

const bundleDir = process.argv[2] ?? '.coverage-bundle'
const mapPath = path.join(bundleDir, 'index.js.map')
const tscDir = path.join(bundleDir, 'tsc')

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

function decode(mappings) {
  const lines = []
  let line = []
  let genCol = 0
  const state = [0, 0, 0, 0] // source, origLine, origCol, name
  let i = 0
  while (i <= mappings.length) {
    const c = mappings[i]
    if (c === ';' || c === undefined) {
      lines.push(line)
      line = []
      genCol = 0
      i++
      continue
    }
    if (c === ',') {
      i++
      continue
    }
    const fields = []
    while (i < mappings.length && mappings[i] !== ',' && mappings[i] !== ';') {
      let value = 0
      let shift = 0
      let digit
      do {
        digit = BASE64.indexOf(mappings[i++])
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
    line.push(seg)
  }
  return lines
}

function encodeVlq(value) {
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

function encode(lines) {
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

const map = JSON.parse(fs.readFileSync(mapPath, 'utf8'))
const lines = decode(map.mappings)

// Bundle lines carrying a segment for `sourceIndex`, with that segment's source line.
function bundleLinesFor(sourceIndex) {
  const out = []
  lines.forEach((segs, i) => {
    const seg = segs.find(s => s[1] === sourceIndex)
    if (seg)
      out.push({ line: i, origLine: seg[2] })
  })
  return out
}

// Pair bundle lines with tsc output lines by source line, in order. Webpack's
// scope hoisting can join a tsc line onto the previous one (`core\n.getInput(`
// becomes `getInput(`), so a tsc line may be skipped; anything else is a mismatch.
function pair(bundleLines, tscLines) {
  const pairs = []
  let j = 0
  for (const b of bundleLines) {
    let k = j
    while (k < tscLines.length && k < j + 4 && tscLines[k].origLine !== b.origLine) k++
    if (k === tscLines.length || k >= j + 4)
      return null
    pairs.push([b.line, tscLines[k].line])
    j = k + 1
  }
  return pairs
}

const summary = { composed: 0, kept: [] }

map.sources.forEach((source, sourceIndex) => {
  const match = source.match(/\/(src\/.*)\.ts$/)
  if (!match)
    return
  const tscMapPath = path.join(tscDir, `${match[1]}.js.map`)
  if (!fs.existsSync(tscMapPath)) {
    summary.kept.push(`${match[1]} (no tsc map)`)
    return
  }
  const tsc = decode(JSON.parse(fs.readFileSync(tscMapPath, 'utf8')).mappings)
  const tscLines = []
  tsc.forEach((segs, i) => {
    if (segs.length)
      tscLines.push({ line: i, origLine: segs[0][2] })
  })
  const pairs = pair(bundleLinesFor(sourceIndex), tscLines)
  if (!pairs) {
    summary.kept.push(`${match[1]} (lines do not pair)`)
    return
  }
  for (const [bundleLine, tscLine] of pairs) {
    const others = lines[bundleLine].filter(s => s[1] !== sourceIndex)
    const composed = tsc[tscLine].map(([genCol, , origLine, origCol]) => [genCol, sourceIndex, origLine, origCol])
    lines[bundleLine] = [...others, ...composed].sort((a, b) => a[0] - b[0])
  }
  summary.composed++
})

map.mappings = encode(lines)
fs.writeFileSync(mapPath, JSON.stringify(map))

console.error(`remap: composed column mappings for ${summary.composed} src/ modules in ${mapPath}`)
for (const kept of summary.kept) console.error(`remap: kept line-only mappings for ${kept}`)
