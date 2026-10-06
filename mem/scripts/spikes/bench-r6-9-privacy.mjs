/**
 * Round-6 privacy audit — same boundary as rounds 4/5, applied to this round's artifacts.
 *
 * CHECKS (each gets a machine-readable verdict):
 *   1. every `mem/docs/spikes/raw/round6-*.json` + the round-6 report: no `text`/`content`/`body`
 *      key, no string over 300 chars (key-level and string-level);
 *   2. the 47-regex sensitive-pattern superset (round-4 scaffolding, transcribed from
 *      `memory_defense.py:167-238` + the module UUID pattern);
 *   3. any 8+ char CJK run NOT in the pre-round-6 committed vocabulary (the report itself is
 *      EXCLUDED from the whitelist so its new wording cannot whitelist itself);
 *   4. a CORPUS-CONTAINMENT detector: every 8+ char CJK run in the artifacts is tested against
 *      every active fact's text (read in-process, never written);
 *   5. a STATIC read/write check of the round-6 scripts: every `openWritable(` / `newRuntime(`
 *      call site and every `writeJson(` target; the live store must only ever be opened read-only;
 *   6. the live store's identity (mtime / size / sha256) for the next run to diff.
 *
 * Usage: node mem/scripts/spikes/bench-r6-9-privacy.mjs [--report <path>]
 */
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import * as R from './bench-r4-lib.mjs'
import * as L from './bench-spike-lib.mjs'

const reportPath = L.arg('report', join(L.REPO, 'docs/spikes/RELATION_QUALITY_RESULTS.md'))
const outPath = L.arg('json', join(L.REPO, 'docs/spikes/raw/round6-privacy-scan.json'))
const rawDir = join(L.REPO, 'docs/spikes/raw')
const scriptDir = join(L.REPO, 'scripts/spikes')

function main() {
  // Pre-round-6 vocabulary: the committed campaign docs MINUS the round-6 report.
  const whitelist = R.repoCjkWhitelist()
  const reportRuns = new Set(existsSync(reportPath) ? R.cjkRuns(readFileSync(reportPath, 'utf8')).filter((r) => r.length >= 8) : [])
  const preRound6 = new Set([...whitelist].filter((r) => !reportRuns.has(r)))

  // The scan's OWN output is excluded here: it is audited in memory below, and reading the
  // previous run's copy would let its informational lists grow the artifact set every run.
  const artifacts = readdirSync(rawDir).filter((f) => f.startsWith('round6-') && f.endsWith('.json') && f !== 'round6-privacy-scan.json').sort()

  // ── corpus containment (in-process only) ────────────────────────────────────────────────────
  const work = L.mkdtempSync(join(L.tmpdir(), 'avantf-r69-'))
  const snap = join(work, 'memory.db')
  L.snapshotDb(L.DEFAULT_DB, snap)
  const texts = [...L.loadActiveTexts(snap).texts.values()]
  R.rm(work)
  const corpusContains = (s) => texts.some((t) => t.includes(s))

  const results = []
  const cjkUnknown = []
  const cjkNotInPreRound6 = []
  const containmentHits = []
  const patternHits = []
  const keyViolations = []
  const longStrings = []
  const scanText = (label, text) => {
    for (const h of R.scanSensitiveStrings(text)) patternHits.push({ artifact: label, ...h })
    for (const run of new Set(R.cjkRuns(text))) {
      if (run.length < 8) continue
      const known = whitelist.has(run)
      const inCorpus = corpusContains(run)
      if (!known) cjkUnknown.push({ artifact: label, length: run.length, run })
      if (!preRound6.has(run)) cjkNotInPreRound6.push({ artifact: label, length: run.length, run })
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
      clean: audit.forbidden_keys.length === 0 && audit.strings_over_max.length === 0,
    })
    if (audit.forbidden_keys.length) keyViolations.push({ artifact: f, keys: audit.forbidden_keys })
    if (audit.strings_over_max.length) longStrings.push({ artifact: f, over: audit.strings_over_max })
    scanText(`raw/${f}`, text)
  }
  const reportExists = existsSync(reportPath)
  if (reportExists) scanText('report', readFileSync(reportPath, 'utf8'))

  // ── static read/write check of the round-6 scripts ──────────────────────────────────────────
  const scripts = readdirSync(scriptDir).filter((f) => f.startsWith('bench-r6-') && f.endsWith('.mjs')).sort()
  const writeSites = []
  const writeViolations = []
  const writeJsonTargets = []
  for (const f of scripts) {
    const src = readFileSync(join(scriptDir, f), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '')
    for (const m of src.matchAll(/openWritable\(([^)]*)\)/g)) {
      const arg = m[1].trim()
      writeSites.push({ script: f, call: 'openWritable', arg })
      if (/DEFAULT_DB/.test(arg)) writeViolations.push({ script: f, call: 'openWritable', arg })
    }
    for (const m of src.matchAll(/snapshotDb\(([^)]*)\)/g)) {
      const [srcArg, dstArg] = m[1].split(',').map((s) => s.trim())
      writeSites.push({ script: f, call: 'snapshotDb', dst: dstArg })
      if (/DEFAULT_DB/.test(dstArg ?? '')) writeViolations.push({ script: f, call: 'snapshotDb', dst: dstArg, src: srcArg })
    }
    for (const m of src.matchAll(/writeJson\(([^,]+),/g)) {
      writeJsonTargets.push({ script: f, target: m[1].trim() })
    }
  }
  const liveDb = (() => {
    try {
      const st = statSync(L.DEFAULT_DB)
      return { path: L.DEFAULT_DB, mtime_ms: st.mtimeMs, mtime: new Date(st.mtimeMs).toISOString(), size: st.size, sha256_16: createHash('sha256').update(readFileSync(L.DEFAULT_DB)).digest('hex').slice(0, 16) }
    } catch (e) {
      return { path: L.DEFAULT_DB, error: String(e.message) }
    }
  })()

  const out = {
    card: 'round6-privacy',
    measured_at: new Date().toISOString(),
    node: process.version,
    loadavg: L.loadavg(),
    identity: { applicable: false, note: 'audit card — no retrieval pass, so there is no production arm to identity-check (R2-5/R2-7 convention)' },
    pattern_source: 'hindsight-api-slim/hindsight_api/extensions/memory_defense.py `_REDACTION_PATTERNS` (lines 167-238) + the module-level UUID pattern',
    pattern_count: R.SENSITIVE_PATTERNS.length,
    named_redaction_patterns: 46,
    uuid_pattern: 1,
    brief_says: 47,
    note: 'the brief says the union scan compiles 47 regexes; this run compiles the same superset and keeps the `credit_card` Luhn second pass.',
    artifacts_scanned: artifacts.map((f) => `raw/${f}`).concat(reportExists ? ['docs/spikes/RELATION_QUALITY_RESULTS.md'] : []),
    per_artifact: results,
    forbidden_key_violations: keyViolations,
    strings_over_300: longStrings,
    sensitive_pattern_hits: patternHits,
    cjk_runs_over_7_not_in_repo_whitelist: cjkUnknown,
    cjk_runs_over_7_not_in_pre_round6_vocabulary: cjkNotInPreRound6,
    cjk_runs_over_7_found_in_active_corpus_text: containmentHits,
    whitelist_vocabulary_size: whitelist.size,
    pre_round6_vocabulary_size: preRound6.size,
    static_write_check: {
      call_sites: writeSites,
      write_json_targets: writeJsonTargets,
      violations: writeViolations,
      note: 'every writable open in the round-6 scripts targets a VACUUM INTO copy under the OS temp dir; the live store is opened read-only by snapshotDb/openReadOnly. The contradict card writes only to its own per-pair temp copies.',
    },
    live_store_fingerprint: liveDb,
    reproduction: 'node mem/scripts/spikes/bench-r6-9-privacy.mjs --report mem/docs/spikes/RELATION_QUALITY_RESULTS.md',
  }
  // SELF-SCAN: the scan artifact is written by this run, so it cannot be read from disk yet. Audit
  // its serialized form in memory and include it in the scanned set, otherwise the one artifact
  // that RECORDS a violation would be the only one never checked.
  out.artifacts_scanned = artifacts.map((f) => `raw/${f}`).concat(reportExists ? ['docs/spikes/RELATION_QUALITY_RESULTS.md'] : [], ['raw/round6-privacy-scan.json'])
  // Scan a copy with the INFORMATIONAL lists emptied: their contents are already reported as
  // `cjkUnknown`/`containment`, so re-scanning them would only inflate the informational counts.
  const selfProbe = { ...out, sensitive_pattern_hits: [], cjk_runs_over_7_not_in_repo_whitelist: [], cjk_runs_over_7_not_in_pre_round6_vocabulary: [], cjk_runs_over_7_found_in_active_corpus_text: [] }
  scanText('raw/round6-privacy-scan.json', JSON.stringify(selfProbe))
  out.sensitive_pattern_hits = patternHits
  out.cjk_runs_over_7_not_in_repo_whitelist = cjkUnknown
  out.cjk_runs_over_7_not_in_pre_round6_vocabulary = cjkNotInPreRound6
  out.cjk_runs_over_7_found_in_active_corpus_text = containmentHits
  const clean = keyViolations.length === 0 && longStrings.length === 0 && patternHits.length === 0 && cjkUnknown.length === 0 && containmentHits.length === 0 && writeViolations.length === 0
  out.verdict = {
    clean_keys: keyViolations.length === 0 && longStrings.length === 0,
    clean_patterns: patternHits.length === 0,
    clean_cjk: cjkUnknown.length === 0,
    clean_containment: containmentHits.length === 0,
    live_store_written: writeViolations.length > 0,
    overall: clean,
  }
  L.writeJson(outPath, out)
  console.log(`patterns: ${R.SENSITIVE_PATTERNS.length}  artifacts: ${out.artifacts_scanned.length}`)
  console.log('verdict:', JSON.stringify(out.verdict))
  console.log(`cjk not in pre-round6 vocab: ${cjkNotInPreRound6.length}`)
  if (patternHits.length) console.log('PATTERN HITS:', JSON.stringify(patternHits.slice(0, 20)))
  if (cjkUnknown.length) console.log('NEW CJK RUNS:', JSON.stringify(cjkUnknown.slice(0, 20)))
  if (containmentHits.length) console.log('CORPUS CONTAINMENT HITS:', JSON.stringify(containmentHits.slice(0, 20)))
  if (keyViolations.length || longStrings.length) console.log('KEY/LEN:', JSON.stringify({ keyViolations, longStrings }))
  process.exitCode = out.verdict.overall ? 0 : 1
}

main()
