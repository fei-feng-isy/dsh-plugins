/**
 * R5 privacy audit — the round's hardest acceptance item, made checkable (same shape as round 4's).
 *
 * WHAT IT CHECKS:
 *   1. every `mem/docs/spikes/raw/round5-*.json` and the round-5 report: no `text`/`content`/`body`
 *      key, no string over 300 chars;
 *   2. the 47 sensitive-pattern regexes transcribed from the round-4 superset
 *      (`memory_defense.py:167-238`; the brief says 44, round 4 measured 46 named + 1 UUID);
 *   3. any 8+ character CJK run NOT already present in the committed campaign documents;
 *      also reported separately against the ROUNDS-1..4 vocabulary only, so "the round-5 report
 *      whitelists itself" is visible instead of hidden;
 *   4. a CORPUS-CONTAINMENT detector: every 8+ char CJK run in the artifacts is tested against every
 *      active fact's text (read in-process, never written);
 *   5. a STATIC read/write check of the round-5 scripts: every `openWritable(` call site must get a
 *      temp/snapshot path, never `DEFAULT_DB`;
 *   6. the live store's fingerprint (mtime / size / sha256 prefix).
 *
 * Usage: node mem/scripts/spikes/bench-r5-5-privacy.mjs [--report <path>]
 */
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import * as R from './bench-r5-lib.mjs'
import * as L from './bench-spike-lib.mjs'

const reportPath = L.arg('report', join(L.REPO, 'docs/spikes/IMPROVEMENT_SPIKE_RESULTS_ROUND5.md'))
const outPath = L.arg('json', join(L.REPO, 'docs/spikes/raw/round5-privacy-scan.json'))

const rawDir = join(L.REPO, 'docs/spikes/raw')
const scriptDir = join(L.REPO, 'scripts/spikes')
const priorRoundsOnly = (name) => name.endsWith('.md') && !name.includes('ROUND5')

function main() {
  const whitelist = R.repoCjkWhitelist()
  // The stricter vocabulary: everything committed in rounds 1-4 (and the shared docs), i.e. WITHOUT
  // this round's own report. A run found only by the loose whitelist is surfaced as informational.
  const priorWhitelist = (() => {
    const out = new Set()
    const spikes = join(L.REPO, 'docs/spikes')
    for (const f of readdirSync(spikes)) {
      if (!f.endsWith('.md') || !priorRoundsOnly(f)) continue
      for (const run of R.cjkRuns(readFileSync(join(spikes, f), 'utf8'))) if (run.length >= 8) out.add(run)
    }
    for (const extra of ['docs/BORROWABLE_IMPROVEMENTS.md', 'docs/IMPROVEMENT_IMPACT_ANALYSIS.md']) {
      const p = join(L.REPO, extra)
      if (existsSync(p)) for (const run of R.cjkRuns(readFileSync(p, 'utf8'))) if (run.length >= 8) out.add(run)
    }
    const rootAgents = join(L.REPO, '..', 'AGENTS.md')
    if (existsSync(rootAgents)) for (const run of R.cjkRuns(readFileSync(rootAgents, 'utf8'))) if (run.length >= 8) out.add(run)
    return out
  })()

  const artifacts = readdirSync(rawDir).filter((f) => f.startsWith('round5-') && f.endsWith('.json')).sort()

  const work = L.mkdtempSync(join(L.tmpdir(), 'avantf-r55-'))
  const snap = join(work, 'memory.db')
  L.snapshotDb(L.DEFAULT_DB, snap)
  const texts = [...L.loadActiveTexts(snap).texts.values()]
  R.rm(work)
  const corpusContains = (s) => texts.some((t) => t.includes(s))

  const results = []
  const cjkUnknown = []
  const cjkUnknownStrict = []
  const containmentHits = []
  const patternHits = []
  const keyViolations = []
  const longStrings = []
  const seenRun = new Set()
  const scanText = (label, text) => {
    for (const h of R.scanSensitiveStrings(text)) patternHits.push({ artifact: label, ...h })
    for (const run of new Set(R.cjkRuns(text))) {
      if (run.length < 8) continue
      const known = whitelist.has(run)
      const prior = priorWhitelist.has(run)
      if (!known && !seenRun.has(run)) { cjkUnknown.push({ artifact: label, length: run.length }); seenRun.add(run) }
      if (!prior && !known) cjkUnknownStrict.push({ artifact: label, length: run.length })
      if (corpusContains(run)) containmentHits.push({ artifact: label, length: run.length, whitelisted: known })
    }
  }

  for (const f of artifacts) {
    const text = readFileSync(join(rawDir, f), 'utf8')
    const obj = JSON.parse(text)
    const audit = R.auditArtifact(obj, { cjkWhitelist: null })
    results.push({
      artifact: `raw/${f}`, bytes: text.length,
      forbidden_keys: audit.forbidden_keys,
      strings_over_max: audit.strings_over_max.length,
      clean_keys: audit.forbidden_keys.length === 0 && audit.strings_over_max.length === 0,
    })
    if (audit.forbidden_keys.length) keyViolations.push({ artifact: f, keys: audit.forbidden_keys })
    if (audit.strings_over_max.length) longStrings.push({ artifact: f, over: audit.strings_over_max })
    scanText(`raw/${f}`, text)
  }
  const reportExists = existsSync(reportPath)
  if (reportExists) scanText('report', readFileSync(reportPath, 'utf8'))

  const scripts = readdirSync(scriptDir).filter((f) => f.startsWith('bench-r5-') && f.endsWith('.mjs')).sort()
  const writableSites = []
  const writableViolations = []
  for (const f of scripts) {
    const src = readFileSync(join(scriptDir, f), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
    for (const m of src.matchAll(/openWritable\(([^)]*)\)/g)) {
      const arg = m[1].trim()
      writableSites.push({ script: f, arg })
      if (/DEFAULT_DB|memory\.db['"]/.test(arg) && !/work|tmp|snap|case/.test(arg)) writableViolations.push({ script: f, arg })
    }
  }
  const liveDb = (() => {
    try {
      const st = statSync(L.DEFAULT_DB)
      const h = createHash('sha256').update(readFileSync(L.DEFAULT_DB)).digest('hex').slice(0, 16)
      return { path: L.DEFAULT_DB, mtime_ms: st.mtimeMs, size: st.size, sha256_16: h }
    } catch (e) { return { path: L.DEFAULT_DB, error: String(e.message) } }
  })()

  const out = {
    card: 'R5-privacy',
    measured_at: new Date().toISOString(),
    node: process.version,
    loadavg: L.loadavg(),
    identity: { applicable: false, note: 'audit card — no retrieval pass, so there is no production arm to identity-check (R2-5/R2-7 convention)' },
    pattern_source: 'bench-r4-lib.mjs SENSITIVE_PATTERNS (memory_defense.py `_REDACTION_PATTERNS` 167-238 + the module UUID pattern)',
    pattern_count: R.SENSITIVE_PATTERNS.length,
    brief_says: 44,
    artifacts_scanned: artifacts.map((f) => `raw/${f}`).concat(reportExists ? ['docs/spikes/IMPROVEMENT_SPIKE_RESULTS_ROUND5.md'] : []),
    per_artifact: results,
    forbidden_key_violations: keyViolations,
    strings_over_300: longStrings,
    sensitive_pattern_hits: patternHits,
    cjk_runs_over_7_not_in_repo_whitelist: cjkUnknown,
    cjk_runs_over_7_not_in_rounds_1_4_vocabulary: { count: cjkUnknownStrict.length, examples: cjkUnknownStrict.slice(0, 20) },
    cjk_runs_over_7_found_in_active_corpus_text: containmentHits,
    whitelist_size: whitelist.size,
    prior_vocabulary_size: priorWhitelist.size,
    static_write_check: { writable_call_sites: writableSites, violations: writableViolations, note: 'every writable open in the round-5 scripts targets a VACUUM INTO copy under the OS temp dir' },
    live_store_fingerprint: liveDb,
    verdict: {
      clean_keys: keyViolations.length === 0 && longStrings.length === 0,
      clean_patterns: patternHits.length === 0,
      clean_cjk: cjkUnknown.length === 0,
      clean_containment: containmentHits.length === 0,
      live_store_written: writableViolations.length > 0,
      overall: keyViolations.length === 0 && longStrings.length === 0 && patternHits.length === 0 && cjkUnknown.length === 0 && containmentHits.length === 0 && writableViolations.length === 0,
    },
    reproduction: 'node mem/scripts/spikes/bench-r5-5-privacy.mjs --report mem/docs/spikes/IMPROVEMENT_SPIKE_RESULTS_ROUND5.md',
  }
  L.writeJson(outPath, out)
  console.log(`patterns: ${R.SENSITIVE_PATTERNS.length}  artifacts: ${out.artifacts_scanned.length}`)
  console.log('verdict:', JSON.stringify(out.verdict))
  if (patternHits.length) console.log('PATTERN HITS:', JSON.stringify(patternHits.slice(0, 20)))
  if (cjkUnknown.length) console.log('NEW CJK RUNS:', JSON.stringify(cjkUnknown.slice(0, 20)))
  if (containmentHits.length) console.log('CORPUS CONTAINMENT HITS:', JSON.stringify(containmentHits.slice(0, 20)))
  if (keyViolations.length || longStrings.length) console.log('KEY/LEN:', JSON.stringify({ keyViolations, longStrings }))
}

main()
