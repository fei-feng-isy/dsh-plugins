#!/usr/bin/env node
/**
 * Audit the two stores for DUPLICATED FLOWS — the "two implementations of one business flow" that
 * this repository keeps re-discovering by hand.
 *
 * WHY. Memory and knowledge are separate aggregates with a shared orchestration layer, and the
 * failure mode is not "someone copied SQL" (that layer is per-aggregate by design) — it is "someone
 * wrote the same FLOW twice, so every later fix lands on one side only". That happened for the
 * retrieval options (see the incident note in `knowledge.hybridDeps`) and for the vector repair
 * itself (DESIGN §20: replaced by the shared flow in `store/vector_repair.ts`).
 *
 * HOW. For every watched file pair it extracts each class method, strips comments, maps the known
 * synonym pairs (`fact`↔`chunk`, `category`↔`domain`, `content`↔`text`, `facts`↔`chunks`…), and
 * scores every cross-file pair by the Dice coefficient over token 3-grams. A high score means the
 * same skeleton with a few key differences — exactly the shape this audit exists to find.
 *
 * WHAT IT CANNOT SEE. The score is LEXICAL, so it finds same-shaped code. A flow that one side
 * implements as a single row and the other as a batch scores low even though the intent is the same
 * (`maybeIndexSemantic` vs `encodeAndStore` was only found by reading). Treat the output as a lower
 * bound and pair it with the manual intent pass when adding a store.
 *
 * USAGE
 *   node scripts/audit-flow-duplication.mjs [--threshold 0.55] [--top 12] [--check] [--json]
 *
 * `--check` exits 1 when any pair scores at or above the threshold, so a closure run can refuse a
 * change that introduces a second copy of a flow.
 */
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** The pairs worth watching: the two stores, and the aggregate DAOs whose algorithms were shared. */
const PAIRS = [
  ['packages/core/src/store/memory.ts', 'packages/core/src/store/knowledge.ts'],
  ['packages/core/src/db/dao/entities.ts', 'packages/core/src/db/dao/chunks.ts'],
  ['packages/core/src/db/dao/facts.ts', 'packages/core/src/db/dao/chunks.ts'],
]

const argv = process.argv.slice(2)
const flag = (name, fallback) => {
  const index = argv.indexOf(name)
  return index < 0 ? fallback : argv[index + 1]
}
if (argv.includes('--help') || argv.includes('-h')) {
  console.log('usage: node scripts/audit-flow-duplication.mjs [--threshold 0.55] [--top 12] [--check] [--json]')
  process.exit(0)
}
const threshold = Number(flag('--threshold', '0.55'))
const top = Number(flag('--top', '12'))
const asJson = argv.includes('--json')
const check = argv.includes('--check')
if (!Number.isFinite(threshold) || threshold <= 0 || threshold > 1) {
  console.error('audit-flow-duplication: --threshold must be inside (0, 1]')
  process.exit(2)
}

/** Class methods of one file: name, 1-based line, body lines (up to the closing brace at indent 2). */
function methods(file) {
  const lines = readFileSync(join(repo, file), 'utf8').split('\n')
  const out = []
  const re = /^  (?:private |public |static )?(?:async )?([a-zA-Z_][a-zA-Z0-9_]*)\s*[<(]/
  const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'return', 'catch', 'constructor'])
  for (let i = 0; i < lines.length; i++) {
    const match = re.exec(lines[i])
    if (match === null || KEYWORDS.has(match[1])) continue
    let end = -1
    for (let j = i + 1; j < lines.length; j++) {
      if (/^  \}/.test(lines[j])) { end = j; break }
    }
    if (end < 0) continue
    out.push({ name: match[1], line: i + 1, body: lines.slice(i, end + 1) })
    i = end
  }
  return out
}

/** The flow skeleton: comments dropped, identifiers mapped onto one vocabulary. */
function normalize(body) {
  const kept = []
  let inBlock = false
  for (const raw of body) {
    const line = raw.trim()
    if (inBlock) { if (line.includes('*/')) inBlock = false; continue }
    if (line.startsWith('/*')) { if (!line.includes('*/')) inBlock = true; continue }
    if (line.startsWith('*') || line.startsWith('//') || line === '') continue
    kept.push(line)
  }
  return kept.join(' ')
    .replace(/\bthis\.(facts|chunks|docs|documents|entities|triples)\b/g, 'DAO')
    .replace(/\b(facts|chunks|docs|documents|chunk_entities|fact_entities)\b/g, 'TABLE')
    .replace(/\bfact_id\b|\bfactId\b|\bchunk_id\b|\bchunkId\b|\bchunkIds\b/g, 'ID')
    .replace(/\bcategory\b|\bdomain\b/g, 'SCOPE')
    .replace(/\bcontent\b|\btext\b/g, 'TEXT')
    .replace(/\bfact\b|\bfacts\b|\bchunk\b|\bchunks\b/g, 'ROW')
    .replace(/\bloadTexts\b|\bchunkTexts\b/g, 'TEXTS')
    .replace(/\bactive\b/g, 'LIVE')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Token 3-grams of the normalized text — the comparable unit. */
function grams(text, size = 3) {
  const tokens = text.split(/[^A-Za-z0-9_$]+/).filter((token) => token !== '')
  const set = new Set()
  for (let i = 0; i + size <= tokens.length; i++) set.add(tokens.slice(i, i + size).join(' '))
  if (set.size === 0) set.add(text)
  return set
}

function dice(a, b) {
  let shared = 0
  for (const gram of a) if (b.has(gram)) shared += 1
  return (2 * shared) / (a.size + b.size)
}

const findings = []
const reported = []
for (const [left, right] of PAIRS) {
  const a = methods(left)
  const b = methods(right)
  reported.push({ left, right, methods: [a.length, b.length] })
  for (const one of a) {
    const ga = grams(normalize(one.body))
    if (ga.size < 8) continue
    for (const two of b) {
      const gb = grams(normalize(two.body))
      if (gb.size < 8) continue
      const score = dice(ga, gb)
      if (score >= 0.35) {
        findings.push({
          score: Number(score.toFixed(3)),
          left: { file: left, name: one.name, line: one.line, grams: ga.size },
          right: { file: right, name: two.name, line: two.line, grams: gb.size },
        })
      }
    }
  }
}
findings.sort((x, y) => y.score - x.score)

if (asJson) {
  console.log(JSON.stringify({ threshold, pairs: reported, findings }, null, 2))
  process.exit(check && findings.some((finding) => finding.score >= threshold) ? 1 : 0)
}

console.log('watched pairs:')
for (const pair of reported) console.log(`  ${pair.left} × ${pair.right}  (${pair.methods[0]}×${pair.methods[1]} methods)`)

/**
 * A FORWARD is a thin adapter: the method exists so the store can hand its own DAO to the shared
 * flow. Two forwards with the same name score 1.000 and mean nothing — what matters is the FLOW,
 * so the candidates below require both sides to carry real body weight.
 */
const FLOW_MIN_LINES = 12
const FLOW_MIN_GRAMS = 40
const bodyLines = (file, line) => {
  const lines = readFileSync(join(repo, file), 'utf8').split('\n')
  let end = line - 1
  for (let j = line; j < lines.length; j++) {
    if (/^  \}/.test(lines[j])) { end = j; break }
  }
  return end - (line - 1) + 1
}

const flows = findings.filter((finding) => {
  const leftLines = bodyLines(finding.left.file, finding.left.line)
  const rightLines = bodyLines(finding.right.file, finding.right.line)
  return Math.min(leftLines, rightLines) >= FLOW_MIN_LINES
    && Math.min(finding.left.grams, finding.right.grams) >= FLOW_MIN_GRAMS
})

console.log(`\nflow-level candidates (both sides >= ${FLOW_MIN_LINES} lines and >= ${FLOW_MIN_GRAMS} 3-grams):\n`)
if (flows.length === 0) {
  console.log('  (none)')
} else {
  console.log('  score  method (left ↔ right)                                  grams   lines')
  for (const finding of flows.slice(0, top)) {
    const name = `${finding.left.name} ↔ ${finding.right.name}`
    console.log(
      `  ${finding.score.toFixed(3)}  ${name.padEnd(52)} ${String(finding.left.grams).padStart(4)}/${String(finding.right.grams).padEnd(6)} ${finding.left.line}/${finding.right.line}`,
    )
  }
}

const forwards = findings.length - flows.length
console.log(`\n(plus ${forwards} higher-scoring pair(s) that are thin forwards — a store hand ing its own DAO to the shared flow, not a second implementation)`)

const over = findings.filter((finding) => finding.score >= threshold)
if (over.length === 0) {
  console.log(`\naudit-flow-duplication: ok — nothing at or above ${threshold.toFixed(2)} looks like a second copy of one flow.`)
  process.exit(0)
}
console.log(`\n⚠ ${over.length} pair(s) at or above ${threshold.toFixed(2)} — read each before assuming duplication:`)
console.log('   a high score can be a legitimate per-aggregate primitive; the question is whether the FLOW')
console.log('   (batching, ordering, caps, floors, stop/resume) is written twice. If it is, lift it into a')
console.log('   shared flow + adapter (see mem/docs/vector-repair-shared-flow.md).')
process.exit(check ? 1 : 0)
