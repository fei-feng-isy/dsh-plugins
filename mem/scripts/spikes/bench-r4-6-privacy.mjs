/**
 * R4 privacy audit — the round's hardest acceptance item, made checkable.
 *
 * WHAT IT CHECKS (each of the brief's six clauses gets a machine-readable verdict):
 *   1. every `mem/docs/spikes/raw/round4-*.json` and the round-4 report: no `text`/`content`/`body`
 *      key, no string over 300 chars;
 *   2. the 46 sensitive patterns transcribed from
 *      `hindsight-api-slim/hindsight_api/extensions/memory_defense.py` (`_REDACTION_PATTERNS`,
 *      lines 167–238 as of 2026-10-06; the brief cites "44" — the file now carries 46 and this scan
 *      uses the superset);
 *   3. any 8+ character CJK run that is NOT already present in the committed campaign documents
 *      (the "terminology whitelist" is the pre-existing public repo vocabulary);
 *   4. a CORPUS-CONTAINMENT leak detector: each 8+ char CJK run in the artifacts is tested against
 *      every active fact's text (read in-process, never written) — a hit would mean real content
 *      reached the repository whatever the whitelist says;
 *   5. a STATIC read/write check of the round-4 scripts: every `openWritable(` call site must get a
 *      temp path, never `DEFAULT_DB`;
 *   6. the live store's identity (mtime / size / sha256) so the next run can diff it.
 *
 * Usage: node mem/scripts/spikes/bench-r4-6-privacy.mjs [--report <path>]
 */
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import * as R from './bench-r4-lib.mjs'
import * as L from './bench-spike-lib.mjs'

const reportPath = L.arg('report', join(L.REPO, 'docs/spikes/IMPROVEMENT_SPIKE_RESULTS_ROUND4.md'))
const outPath = L.arg('json', join(L.REPO, 'docs/spikes/raw/round4-privacy-scan.json'))

const rawDir = join(L.REPO, 'docs/spikes/raw')
const scriptDir = join(L.REPO, 'scripts/spikes')

function main() {
  const whitelist = R.repoCjkWhitelist()
  const artifacts = readdirSync(rawDir).filter((f) => f.startsWith('round4-') && f.endsWith('.json')).sort()

  // ── corpus containment (in-process only) ──────────────────────────────────────────────────────
  const work = L.mkdtempSync(join(L.tmpdir(), 'avantf-r46-'))
  const snap = join(work, 'memory.db')
  L.snapshotDb(L.DEFAULT_DB, snap)
  const texts = [...L.loadActiveTexts(snap).texts.values()]
  R.rm(work)
  const corpusContains = (s) => texts.some((t) => t.includes(s))

  const results = []
  const cjkUnknown = []
  const containmentHits = []
  const patternHits = []
  const keyViolations = []
  const longStrings = []
  const scanText = (label, text) => {
    for (const h of R.scanSensitiveStrings(text)) patternHits.push({ artifact: label, ...h })
    const runs = new Set(R.cjkRuns(text))
    for (const run of runs) {
      if (run.length < 8) continue
      const known = whitelist.has(run)
      const inCorpus = corpusContains(run)
      if (!known) cjkUnknown.push({ artifact: label, length: run.length, run })
      if (inCorpus) containmentHits.push({ artifact: label, length: run.length, run, whitelisted: known })
    }
  }

  for (const f of artifacts) {
    const text = readFileSync(join(rawDir, f), 'utf8')
    const obj = JSON.parse(text)
    const audit = R.auditArtifact(obj, { cjkWhitelist: null })
    results.push({
      artifact: `raw/${f}`,
      bytes: text.length,
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

  // ── static read/write check of the round-4 scripts ────────────────────────────────────────────
  const scripts = readdirSync(scriptDir).filter((f) => f.startsWith('bench-r4-') && f.endsWith('.mjs')).sort()
  const writableSites = []
  const writableViolations = []
  for (const f of scripts) {
    // strip comments first: this audit's own doc text names the call it looks for
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
    card: 'R4-privacy',
    measured_at: new Date().toISOString(),
    node: process.version,
    loadavg: L.loadavg(),
    identity: { applicable: false, note: 'audit card — no retrieval pass, so there is no production arm to identity-check (R2-5/R2-7 convention)' },
    pattern_source: 'hindsight-api-slim/hindsight_api/extensions/memory_defense.py `_REDACTION_PATTERNS` (lines 167-238) + the module-level `_UUID_PATTERN`',
    pattern_count: R.SENSITIVE_PATTERNS.length,
    named_redaction_patterns: 46,
    uuid_pattern: 1,
    brief_says: 44,
    note: 'the brief cites 44 patterns; the cited block carries 46 named patterns and the module adds one separate UUID pattern, so this scan compiles 47 regexes — a superset either way. The credit_card rule keeps the source Luhn second pass.',
    artifacts_scanned: artifacts.map((f) => `raw/${f}`).concat(reportExists ? ['docs/spikes/IMPROVEMENT_SPIKE_RESULTS_ROUND4.md'] : []),
    per_artifact: results,
    forbidden_key_violations: keyViolations,
    strings_over_300: longStrings,
    sensitive_pattern_hits: patternHits,
    cjk_runs_over_7_not_in_repo_whitelist: cjkUnknown,
    cjk_runs_over_7_found_in_active_corpus_text: containmentHits,
    whitelist_vocabulary_size: whitelist.size,
    static_write_check: {
      writable_call_sites: writableSites,
      violations: writableViolations,
      note: 'every writable open in the round-4 scripts targets a VACUUM INTO copy under the OS temp dir; the live store is opened read-only by snapshotDb/openReadOnly',
    },
    live_store_fingerprint: liveDb,
    verdict: {
      clean_keys: keyViolations.length === 0 && longStrings.length === 0,
      clean_patterns: patternHits.length === 0,
      clean_cjk: cjkUnknown.length === 0,
      clean_containment: containmentHits.length === 0,
      live_store_written: writableViolations.length > 0,
      overall: keyViolations.length === 0 && longStrings.length === 0 && patternHits.length === 0 && cjkUnknown.length === 0 && containmentHits.length === 0 && writableViolations.length === 0,
    },
    reproduction: 'node mem/scripts/spikes/bench-r4-6-privacy.mjs',
  }
  L.writeJson(outPath, out)
  console.log(`patterns: ${R.SENSITIVE_PATTERNS.length}  artifacts: ${out.artifacts_scanned.length}`)
  console.log('verdict:', JSON.stringify(out.verdict))
  if (patternHits.length) console.log('PATTERN HITS:', JSON.stringify(patternHits.slice(0, 20)))
  if (cjkUnknown.length) console.log('NEW CJK RUNS:', JSON.stringify(cjkUnknown.slice(0, 20)))
  if (containmentHits.length) console.log('CORPUS CONTAINMENT HITS:', JSON.stringify(containmentHits.slice(0, 20)))
  if (keyViolations.length || longStrings.length) console.log('KEY/LEN:', JSON.stringify({ keyViolations, longStrings }))
  process.exitCode = out.verdict.overall ? 0 : 1
}

main()
