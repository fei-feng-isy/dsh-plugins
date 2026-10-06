#!/usr/bin/env node
/**
 * mem benchmark harness v1 — one-command full run.
 *
 *   node mem/scripts/bench/run.mjs --out mem/docs/bench/baseline.json
 *
 * It builds the machine artifact (JSON) and the human report (markdown) from the SAME run, so the
 * two can never drift. Axes and their metrics are the spec's (`mem/docs/BENCHMARK.md` §1):
 *
 *   A quality     — frozen 41 aggregate (bit-identical to `eval_zh.spec.ts`), the derived query set
 *                   by shape, guards, the collision counterfactual, explainability;
 *   B write       — dedup, contradictions + adjudication, supersede chain, coverage columns, entity
 *                   columns;
 *   C performance — read/write p50/p95 on the real snapshot + synthetic 2k/10k, build time, db
 *                   bytes, RSS, per-leg attribution;
 *   D hardening   — synthetic positives, repo/doc-placeholder negatives, live-corpus injury counts;
 *   E integrity   — migration chain, existing invariant probes, WIRE_VERSION.
 *
 * EVERY run records HEAD / status summary / loadavg / Node+pnpm / corpus fingerprint / seed / the
 * reproduction command. The artifact is written only after a key-level + pattern + corpus-
 * containment screen passes with zero hits (`mem/docs/BENCHMARK.md` §0).
 */
import { copyFileSync, mkdtempSync } from 'node:fs'
import { basename, join, resolve } from 'node:path'
import {
  BENCH_NOW, BENCH_SCHEMA, DEFAULT_SEED, L, REPO, TMP, WORKSPACE, containmentOracle, corpusFingerprint, ensureTmp,
  envInfo, fileSha256, gateArtifact, gateText, gitInfo, pct, repoVocabulary, resolveCorpus, round4,
  spike, writeRepoJson, writeRepoText, writeTmpJson, tmpPath, harnessDigest,
} from './lib/common.mjs'
import { buildDerivedQueries, persistDerived, runDerived, summarizeDerived } from './lib/derived.mjs'
import {
  runCollisionSentinel, runCoverageAdminProbe, runExplainability, runExplainabilityIncludeScores, runFrozen41, runWriteAxis,
} from './lib/quality.mjs'
import { benchLegs, benchReads, benchWrites, measureRuntime, runHardening, runIntegrity, runIntegrityOnTempCopy } from './lib/perf.mjs'
import { materializeSynthetic, clearSyntheticCache, GEN_VERSION } from './lib/synthetic.mjs'
import { renderReport } from './lib/report.mjs'

// ─── argv ──────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2)
const flag = (name) => argv.includes(`--${name}`)
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`)
  return i === -1 ? fallback : argv[i + 1]
}

const label = opt('label', null) ?? (opt('out', 'mem/docs/bench/baseline.json').split('/').pop() ?? 'baseline').replace(/\.json$/, '')
const outRel = opt('out', `mem/docs/bench/${label}.json`)
const outAbs = resolve(WORKSPACE, outRel)
const reportRel = opt('report', `mem/docs/bench/${label === 'baseline' ? 'BASELINE' : label.toUpperCase()}_REPORT.md`)
const reportAbs = resolve(WORKSPACE, reportRel)
const seed = Number(opt('seed', DEFAULT_SEED))
const pinnedNow = opt('now', BENCH_NOW)
const annotationDir = opt('annotation-dir', join(TMP, '..', 'dsh-r4'))
const onlyAxes = (opt('axes', 'ABCDE') ?? 'ABCDE').toUpperCase()
const quick = flag('quick')
const fresh = flag('fresh')
const writeDiscovery = flag('discover')
const synthSizes = (opt('synth', quick ? '2000' : '2000,10000') ?? '').split(',').map((s) => Number(s.trim())).filter((n) => n > 0)
const repsReal = Number(opt('reps-real', quick ? 2 : 5))
const repsSynth = Number(opt('reps-synth', quick ? 1 : 3))
const writePayloads = Number(opt('writes', quick ? 8 : 30))

const want = (a) => onlyAxes.includes(a)
const t0 = Date.now()
const track = { runtimes: [], dirs: [] }
const notes = [
  'A1 与 eval_zh.spec.ts 同源：聚合逐位相等，另记 (ids, scores) 指纹；不相等则本次运行直接失败。',
  '合成 2k/10k 语料按 (生成器版本, 行数, seed, 模型, 维度) 缓存在 /tmp/dsh-bench/cache，重跑测同一份字节；--fresh 强制重建。',
  'C4 分腿计时是同一查询上顺序调用生产腿方法，用于归因；生产实际并发，所以占比不是墙钟分解。',
  '隐私：派生字符串只落 /tmp/dsh-bench；产物通过键级 + 47 正则 + 活库正文包含三重扫描后才写盘。',
  '本次 harness 相对基线新增 4 个探针（A5b/B4b/E1b/E2b），见 result.new_probes 与 metric.*.new_probe；既有探针与指标定义未改动。',
  '真实语料轴用 corpus.real.identity_sha256（VACUUM INTO 快照的字节 sha）判可比；活库主文件 sha 会因 WAL 滞后，只作信息项。',
]
const unsupported = []

console.log(`== mem bench · ${label} ==`)
console.log(`  out: ${outRel}`)
console.log(`  axes: ${onlyAxes}  seed: ${seed}  now: ${pinnedNow}`)

ensureTmp()
if (fresh) clearSyntheticCache()

// ─── header + snapshot + fingerprint ───────────────────────────────────────────
const environment = envInfo()
const git = gitInfo()
const work = mkdtempSync(join(TMP, 'run-'))
track.dirs.push(work)
/**
 * Corpus source. Default: a fresh read-only `VACUUM INTO` of the live store. `--snapshot <path>`
 * pins a fixed copy instead, which is the ONLY way two runs can share one byte-identical real
 * corpus after the live store has drifted; in that mode the live store is never read at all.
 */
const pinnedSnapshot = opt('snapshot', null)
const corpusChoice = resolveCorpus({ pinnedPath: pinnedSnapshot, dir: work })
const snap = corpusChoice.path
const corpusReal = corpusFingerprint(snap, { source: corpusChoice.source })
corpusReal.pinned_snapshot_basename = pinnedSnapshot ? basename(resolve(pinnedSnapshot)) : null
/**
 * The axes that MEASURE against the real store still write to it: `recall` reinforces trust, and
 * the write benchmark adds synthetic rows. Each such axis therefore gets its OWN byte copy, so the
 * pristine `snap` keeps the corpus fingerprint every read-only card (B4/B5/D3/E) reports on.
 */
const copySnapshot = (name) => {
  const dir = mkdtempSync(join(TMP, `copy-${name}-`))
  track.dirs.push(dir)
  const dst = join(dir, 'memory.db')
  copyFileSync(snap, dst)
  return dst
}
console.log(`  HEAD ${git.head.slice(0, 12)}  packages_clean=${git.packages_clean}  active=${corpusReal.active}  user_version=${corpusReal.user_version}`)
console.log(`  corpus: ${corpusReal.corpus_source}${pinnedSnapshot ? ` (${corpusReal.pinned_snapshot_basename})` : ''}  identity=${String(corpusReal.identity_sha256).slice(0, 12)}  snapshot=${String(corpusReal.snapshot_sha256).slice(0, 12)}`)

const emb = await L.warmEmbedder()
const DEFAULT_MODEL = spike.DEFAULT_MODEL
const DEFAULT_DIM = spike.DEFAULT_DIM

// ─── A · quality ───────────────────────────────────────────────────────────────
let A1 = null
let A2 = null
let A3 = null
let A4 = null
let A5 = null
let A5b = null
let selfRows = []
if (want('A')) {
  A1 = await runFrozen41({ track })
  selfRows = A1.self_query_rows
  if (!A1.frozen_match_all) throw new Error(`A1: frozen 41 aggregate no longer matches eval_zh.spec.ts — ${JSON.stringify(A1.frozen_match)}`)

  const rtReal = L.newRuntime({ snapPath: copySnapshot('a2'), semantic: emb, track })
  const { records, sources, corpusStats } = buildDerivedQueries({ snapPath: snap, annotationDir, now: new Date(pinnedNow) })
  const derivedPath = persistDerived(records, { ...sources, corpus: corpusStats })
  const rows = await runDerived(rtReal, records, { limit: 5, textsByIdentity: true })
  const allRows = rows.concat(selfRows)
  A2 = {
    ...summarizeDerived(allRows),
    self_query: summarizeDerived(selfRows).self_query ?? null,
    derivation: {
      ...sources,
      derived_artifact: derivedPath,
      records: records.length,
      shapes: Object.fromEntries(Object.entries(summarizeDerived(allRows)).map(([k, v]) => [k, v.queries])),
    },
    per_query: rows.map((r) => ({ ...r })),
  }
  // A3 · guards
  const guardRows = rows.filter((r) => r.shape === 'guard_no_time')
  const irrRows = rows.filter((r) => r.shape === 'guard_irrelevant')
  const idTrack = { runtimes: track.runtimes, dirs: [], texts: L.loadActiveTexts(snap).texts }
  const idSample = records.filter((_, i) => i % Math.max(1, Math.floor(records.length / 12)) === 0).slice(0, 12)
  const idRecords = []
  for (const rec of idSample) idRecords.push(await L.identityCheck(rtReal, rec.query, { limit: 5, maxTokens: 0, track: idTrack }))
  A3 = {
    no_time_guard: {
      queries: guardRows.length,
      identical_to_baseline: guardRows.length,
      identical_rate: pct(guardRows.length, guardRows.length),
      tautological_pre_implementation: true,
      note: 'no window leg exists before the plan lands, so the guard pass IS the baseline pass; the card becomes discriminating once a window leg exists',
    },
    irrelevant_guard: {
      queries: irrRows.length,
      empty: irrRows.filter((r) => r.empty).length,
      empty_rate: pct(irrRows.filter((r) => r.empty).length, irrRows.length),
      non_empty_ids: irrRows.filter((r) => !r.empty).map((r) => r.id),
      expectation: 'must return nothing',
    },
    identity: {
      checked: idRecords.length,
      passed: idRecords.filter((r) => r.ok).length,
      failed_query_ids: idRecords.filter((r) => !r.ok).map((r) => r.query),
      note: 'script-side reproduction vs production rt.recall (bench-spike-lib identityCheck)',
    },
  }
  A4 = await runCollisionSentinel({ track })
  A5 = await runExplainability({ rt: rtReal })
  // NEW PROBE — additive; asks the same store WITH include_scores: true.
  A5b = await runExplainabilityIncludeScores({ rt: rtReal })
}

// ─── B · write & lifecycle ─────────────────────────────────────────────────────
let B = null
if (want('B')) {
  B = await runWriteAxis({ snapshotPath: snap, track })
  // NEW PROBE — product-surface coverage (`admin stats`) alongside the schema-only B4 above.
  B.B4admin = (await runCoverageAdminProbe({ snapshotPath: snap, track })).B4admin
}

// ─── C · performance ───────────────────────────────────────────────────────────
let C = null
if (want('C')) {
  const real = await measureRuntime({ dbPath: copySnapshot('c'), emb, track, model: DEFAULT_MODEL, dim: DEFAULT_DIM })
  const realReads = await benchReads(real.rt, L.REAL_QUERIES, { reps: repsReal, limit: 5 })
  const legs = await benchLegs(real.rt, L.REAL_QUERIES.slice(0, 10), { limit: 5 })
  const rssReal = L.rssMiB()
  const realWrites = await benchWrites(real.rt, { n: writePayloads })
  real.rt.shutdown()

  const synthetic = {}
  for (const n of synthSizes) {
    const mat = await materializeSynthetic({ n, seed, emb, model: DEFAULT_MODEL, dim: DEFAULT_DIM, track })
    const rt = await measureRuntime({ dbPath: mat.dbPath, emb, track, model: DEFAULT_MODEL, dim: DEFAULT_DIM })
    const reads = await benchReads(rt.rt, L.REAL_QUERIES, { reps: repsSynth, limit: 5 })
    const rss = L.rssMiB()
    rt.rt.shutdown()
    synthetic[n] = { corpus: mat.meta, cache_hit: mat.cacheHit, build_ms: rt.buildMs, db_bytes: rt.dbBytes, reads, leg_timing: null, rss_mib: rss }
  }
  const synth2k = synthetic[2000] ?? Object.values(synthetic)[0] ?? null
  const synth10k = synthetic[10000] ?? null
  C = {
    query_set: { source: 'bench-spike-lib REAL_QUERIES (20, committed)', ids: L.REAL_QUERIES.map((q) => q.id) },
    C1: {
      real_snapshot: { corpus: { kind: 'live snapshot', active: corpusReal.active, sha256: corpusReal.snapshot_sha256 }, reads: realReads },
      synthetic_2k: synth2k ? { corpus: synth2k.corpus, cache_hit: synth2k.cache_hit, reads: synth2k.reads } : null,
      synthetic_10k: synth10k ? { corpus: synth10k.corpus, cache_hit: synth10k.cache_hit, reads: synth10k.reads } : null,
    },
    C2: { real_snapshot: realWrites },
    C3: {
      build_runtime_ms: {
        real_snapshot: real.buildMs,
        synthetic_2k: synth2k?.build_ms ?? null,
        synthetic_10k: synth10k?.build_ms ?? null,
      },
      db_bytes: {
        real_snapshot: real.dbBytes,
        synthetic_2k: synth2k?.db_bytes ?? null,
        synthetic_10k: synth10k?.db_bytes ?? null,
      },
      rss_mib: { start: environment.rss_start_mib, real_snapshot: rssReal, synthetic_2k: synth2k?.rss_mib ?? null, synthetic_10k: synth10k?.rss_mib ?? null },
    },
    C4: { real_snapshot: legs },
    synthetic_corpora: Object.entries(synthetic).map(([n, s]) => ({
      name: `synth-${n}`,
      rows: Number(n),
      seed,
      gen_version: GEN_VERSION,
      content_sha256: s.corpus.content_sha256,
      db_sha256: s.corpus.db_sha256,
      corpus_build_ms: s.corpus.build_ms,
      cache_hit: s.cache_hit,
      runtime_build_ms: s.build_ms,
      db_bytes: s.db_bytes,
      rss_mib: s.rss_mib,
    })),
  }
}

// ─── D · hardening ─────────────────────────────────────────────────────────────
let D = null
if (want('D')) D = await runHardening({ snapshotPath: snap, track })

// ─── E · integrity ─────────────────────────────────────────────────────────────
let E = null
if (want('E')) {
  E = await runIntegrity({ snapshotPath: snap, track })
  // NEW PROBE — migrate a temp COPY with the product and run the product invariants on it.
  const copyProbe = await runIntegrityOnTempCopy({ snapshotPath: snap, track })
  E.E1b = copyProbe.E1b
  E.E2b = copyProbe.E2b
}

// ─── compose metrics ───────────────────────────────────────────────────────────
const metrics = {}
const M = (key, value, axis, unit, direction, meta = {}) => {
  metrics[key] = { value: value === undefined ? null : value, axis, unit, direction, ...meta }
}
/**
 * Meta for a metric produced by a NEW probe (`HARNESS_EXTENSION.md`). It carries `new_probe` so
 * both the artifact and `compare.mjs` label it instead of presenting it as a delta against the
 * baseline, plus the comparability class (`strict` vs `corpus_drift`).
 */
const NEW = (comparability) => ({ new_probe: true, comparability })

if (A1) {
  M('A1.n_queries', A1.summary.n_queries, 'A', 'count', 'neutral')
  M('A1.mean_precision_at_k', A1.summary.mean_precision_at_k, 'A', 'ratio', 'higher_better')
  M('A1.mean_recall_at_k', A1.summary.mean_recall_at_k, 'A', 'ratio', 'higher_better')
  M('A1.mrr', A1.summary.mrr, 'A', 'ratio', 'higher_better')
  M('A1.ndcg_at_k', A1.ndcg_at_k, 'A', 'ratio', 'higher_better')
  M('A1.empty_rate', A1.summary.empty_rate, 'A', 'ratio', 'lower_better')
  M('A1.must_include_pass_rate', A1.summary.must_include_pass_rate, 'A', 'ratio', 'higher_better')
  M('A1.must_exclude_pass_rate', A1.summary.must_exclude_pass_rate, 'A', 'ratio', 'higher_better')
  M('A1.frozen_match_all', A1.frozen_match_all, 'A', 'bool', 'neutral')
  M('A1.fingerprint', A1.fingerprint.value, 'A', 'sha256', 'neutral')
}
if (A2) {
  for (const [shape, s] of Object.entries(A2)) {
    if (shape === 'derivation' || shape === 'per_query') continue
    M(`A2.${shape}.queries`, s.queries, 'A', 'count', 'neutral')
    M(`A2.${shape}.top1_rate`, s.top1_rate, 'A', 'ratio', 'higher_better')
    M(`A2.${shape}.top3_rate`, s.top3_rate, 'A', 'ratio', 'higher_better')
    M(`A2.${shape}.missing_rate`, s.missing_rate, 'A', 'ratio', 'lower_better')
    M(`A2.${shape}.mean_gold_rank`, s.mean_gold_rank, 'A', 'rank', 'lower_better')
    M(`A2.${shape}.empty_rate`, s.empty_rate, 'A', 'ratio', 'lower_better')
  }
}
if (A3) {
  M('A3.no_time_guard_identical_rate', A3.no_time_guard.identical_rate, 'A', 'ratio', 'higher_better')
  M('A3.irrelevant_guard_empty_rate', A3.irrelevant_guard.empty_rate, 'A', 'ratio', 'higher_better')
  M('A3.identity_passed', A3.identity.passed, 'A', 'count', 'higher_better')
  M('A3.identity_checked', A3.identity.checked, 'A', 'count', 'neutral')
}
if (A4) {
  M('A4.sentinels', A4.sentinels, 'A', 'count', 'neutral')
  M('A4.passed', A4.passed, 'A', 'count', 'higher_better')
  M('A4.all_pass', A4.all_pass, 'A', 'bool', 'neutral')
}
if (A5) {
  M('A5.per_leg_scores', A5.capability.per_leg_scores, 'A', 'bool', 'neutral')
  M('A5.envelope_bytes', A5.envelope_bytes, 'A', 'bytes', 'lower_better')
}
if (A5b) {
  M('A5b.include_scores_supported', A5b.capability.include_scores_flag_supported, 'A', 'bool', 'neutral', NEW('corpus_drift'))
  M('A5b.default_still_unsupported', A5b.capability.per_leg_scores_default === false, 'A', 'bool', 'neutral', NEW('corpus_drift'))
  M('A5b.leg_field_count', A5b.capability.leg_field_names.length, 'A', 'count', 'neutral', NEW('corpus_drift'))
  M('A5b.leg_non_null_on_first_hit', A5b.capability.legs_non_null_on_first_hit, 'A', 'count', 'neutral', NEW('corpus_drift'))
  M('A5b.final_score_field_present', A5b.capability.final_score_field_present, 'A', 'bool', 'neutral', NEW('corpus_drift'))
  M('A5b.payload_bytes_default', A5b.payload.default_bytes, 'A', 'bytes', 'neutral', NEW('corpus_drift'))
  M('A5b.payload_bytes_with_flag', A5b.payload.with_flag_bytes, 'A', 'bytes', 'neutral', NEW('corpus_drift'))
  M('A5b.payload_bytes_delta', A5b.payload.delta_bytes, 'A', 'bytes', 'neutral', NEW('corpus_drift'))
}
if (B) {
  M('B1.verbatim_rows_unchanged', B.B1.verbatim_duplicate.rows_unchanged, 'B', 'bool', 'neutral')
  M('B1.rewrite_new_rows', B.B1.rewrite_near_duplicates.new_rows, 'B', 'count', 'neutral')
  M('B1.near_dup_similarity_p50', B.B1.rewrite_near_duplicates.similarity_distribution.p50, 'B', 'ratio', 'neutral')
  M('B1.dedup_ok', B.B1.dedup_ok, 'B', 'bool', 'neutral')
  M('B2.true_pair_reported', B.B2.true_pair.reported, 'B', 'bool', 'neutral')
  M('B2.false_pair_reported', B.B2.false_pair.reported, 'B', 'bool', 'neutral')
  M('B2.adjudication_true_positive_ok', B.B2.adjudication_true_positive?.correct ?? false, 'B', 'bool', 'neutral')
  M('B2.adjudication_false_positive_ok', B.B2.adjudication_false_positive?.both_active ?? false, 'B', 'bool', 'neutral')
  M('B2.contradiction_ok', B.B2.contradiction_ok, 'B', 'bool', 'neutral')
  M('B3.chain_ok', B.B3.chain_ok, 'B', 'bool', 'neutral')
  M('B3.reverse_lookup_hits', B.B3.reverse_lookup_from_v1.length, 'B', 'count', 'neutral')
  M('B4.valid_from_coverage', B.B4.columns.valid_from.coverage, 'B', 'ratio', 'higher_better')
  M('B4.fact_sources_coverage', B.B4.columns.fact_sources.coverage, 'B', 'ratio', 'higher_better')
  M('B4.assert_count_gt1', B.B4.columns.assert_count.greater_than_1, 'B', 'count', 'neutral')
  M('B4.supported', B.B4.supported, 'B', 'bool', 'neutral')
  M('B5.entity_type_distinct', B.B5.entity_type.distinct, 'B', 'count', 'higher_better')
  M('B5.extraction_method_distinct', B.B5.extraction_method.distinct, 'B', 'count', 'higher_better')
  if (B.B4admin) {
    M('B4b.product_face_supported', B.B4admin.product_face_supported, 'B', 'bool', 'neutral', NEW('corpus_drift'))
    M('B4b.source_coverage', B.B4admin.source_coverage?.coverage ?? null, 'B', 'ratio', 'higher_better', NEW('corpus_drift'))
    M('B4b.valid_from_coverage', B.B4admin.valid_from_coverage?.coverage ?? null, 'B', 'ratio', 'higher_better', NEW('corpus_drift'))
    M('B4b.assert_count_gt1', B.B4admin.assert_count_gt1, 'B', 'count', 'neutral', NEW('corpus_drift'))
    M('B4b.assert_count_cross_check', B.B4admin.assert_count_cross_check ?? null, 'B', 'bool', 'neutral', NEW('corpus_drift'))
    M('B4b.migrated_on_open', B.B4admin.corpus?.migrated_on_open ?? null, 'B', 'bool', 'neutral', NEW('corpus_drift'))
  }
}
if (C) {
  M('C1.real_snapshot.p50_ms', C.C1.real_snapshot.reads.stats.p50, 'C', 'ms', 'lower_better')
  M('C1.real_snapshot.p95_ms', C.C1.real_snapshot.reads.stats.p95, 'C', 'ms', 'lower_better')
  if (C.C1.synthetic_2k) {
    M('C1.synthetic_2k.p50_ms', C.C1.synthetic_2k.reads.stats.p50, 'C', 'ms', 'lower_better')
    M('C1.synthetic_2k.p95_ms', C.C1.synthetic_2k.reads.stats.p95, 'C', 'ms', 'lower_better')
  }
  if (C.C1.synthetic_10k) {
    M('C1.synthetic_10k.p50_ms', C.C1.synthetic_10k.reads.stats.p50, 'C', 'ms', 'lower_better')
    M('C1.synthetic_10k.p95_ms', C.C1.synthetic_10k.reads.stats.p95, 'C', 'ms', 'lower_better')
  }
  M('C2.remember_add.p50_ms', C.C2.real_snapshot.stats.p50, 'C', 'ms', 'lower_better')
  M('C2.remember_add.p95_ms', C.C2.real_snapshot.stats.p95, 'C', 'ms', 'lower_better')
  M('C3.build_runtime_real_ms', C.C3.build_runtime_ms.real_snapshot, 'C', 'ms', 'lower_better')
  M('C3.build_runtime_2k_ms', C.C3.build_runtime_ms.synthetic_2k, 'C', 'ms', 'lower_better')
  M('C3.build_runtime_10k_ms', C.C3.build_runtime_ms.synthetic_10k, 'C', 'ms', 'lower_better')
  M('C3.db_bytes_real', C.C3.db_bytes.real_snapshot, 'C', 'bytes', 'lower_better')
  M('C3.db_bytes_2k', C.C3.db_bytes.synthetic_2k, 'C', 'bytes', 'lower_better')
  M('C3.db_bytes_10k', C.C3.db_bytes.synthetic_10k, 'C', 'bytes', 'lower_better')
  M('C3.rss_mib_real', C.C3.rss_mib.real_snapshot, 'C', 'MiB', 'lower_better')
  M('C3.rss_mib_2k', C.C3.rss_mib.synthetic_2k, 'C', 'MiB', 'lower_better')
  M('C3.rss_mib_10k', C.C3.rss_mib.synthetic_10k, 'C', 'MiB', 'lower_better')
  for (const leg of ['prep', 'semantic', 'fts', 'jaccard', 'hrr']) {
    M(`C4.${leg}_share`, C.C4.real_snapshot.legs[leg].share_of_sequential_total, 'C', 'ratio', 'neutral')
    M(`C4.${leg}_p50_ms`, C.C4.real_snapshot.legs[leg].stats.p50, 'C', 'ms', 'lower_better')
  }
}
if (D) {
  M('D1.samples', D.D1.samples, 'D', 'count', 'neutral')
  M('D1.rejection_rate', D.D1.rejection_rate, 'D', 'ratio', 'higher_better')
  M('D1.scanner_detected', D.D1.scanner_detected, 'D', 'count', 'neutral')
  M('D2.samples', D.D2.samples, 'D', 'count', 'neutral')
  M('D2.false_rejection_rate', D.D2.false_rejection_rate, 'D', 'ratio', 'lower_better')
  M('D2.repo_flagged_example_strings', D.D2.repo_flagged_example_strings, 'D', 'count', 'lower_better')
  M('D3.facts_scanned', D.D3.facts_scanned, 'D', 'count', 'neutral')
  M('D3.facts_with_any_pattern_hit', D.D3.facts_with_any_pattern_hit, 'D', 'count', 'lower_better')
  M('D3.total_hits', D.D3.total_hits, 'D', 'count', 'lower_better')
}
if (E) {
  M('E1.applicable', E.E1.applicable, 'E', 'bool', 'neutral')
  M('E1.live_user_version', E.E1.live_user_version, 'E', 'version', 'neutral')
  M('E1.fresh_user_version', E.E1.fresh_user_version, 'E', 'version', 'neutral')
  M('E1.live_chain_equals_fresh', E.E1.live_chain_equals_fresh, 'E', 'bool', 'neutral')
  M('E2.applicable', E.E2.applicable, 'E', 'bool', 'neutral')
  M('E2.active_supersedes_target_not_archived', E.E2.probes.active_supersedes_target_not_archived, 'E', 'count', 'lower_better')
  M('E2.supersedes_target_missing', E.E2.probes.supersedes_target_missing, 'E', 'count', 'lower_better')
  M('E3.wire_version', E.E3.wire_version, 'E', 'version', 'neutral')
  M('E3.host_stamps_wire', E.E3.host_stamps_wire, 'E', 'bool', 'neutral')
  M('E3.client_skew_module_present', E.E3.client_skew_module_present, 'E', 'bool', 'neutral')
  if (E.E1b) {
    M('E1b.input_user_version', E.E1b.input_user_version, 'E', 'version', 'neutral', NEW('corpus_drift'))
    M('E1b.upgraded_user_version', E.E1b.upgraded_user_version, 'E', 'version', 'neutral', NEW('corpus_drift'))
    M('E1b.fresh_user_version', E.E1b.fresh_user_version, 'E', 'version', 'neutral', NEW('corpus_drift'))
    M('E1b.migrated_equals_fresh', E.E1b.migrated_equals_fresh, 'E', 'bool', 'neutral', NEW('corpus_drift'))
    M('E1b.diff_parts', E.E1b.diff_parts.length, 'E', 'count', 'lower_better', NEW('corpus_drift'))
  }
  if (E.E2b?.fresh_violations) {
    M('E2b.fresh_violations', E.E2b.fresh_violations.retired_without_valid_to + E.E2b.fresh_violations.valid_to_before_valid_from, 'E', 'count', 'lower_better', NEW('corpus_drift'))
    M('E2b.upgraded_violations', E.E2b.upgraded_violations.retired_without_valid_to + E.E2b.upgraded_violations.valid_to_before_valid_from, 'E', 'count', 'lower_better', NEW('corpus_drift'))
    M('E2b.planted_violation_detected', E.E2b.planted.detected, 'E', 'bool', 'higher_better', NEW('corpus_drift'))
  }
}

// ─── unsupported / expected-zero ledger ────────────────────────────────────────
if (A5) unsupported.push({ item: 'A5 逐腿原始分', measured: A5.capability.per_leg_scores ? 'supported' : 'unsupported', note: '结果信封只有聚合丢弃数与权重/门槛，没有每腿每命中原始分' })
if (B) {
  unsupported.push({ item: 'B1 近重复判定', measured: `${B.B1.rewrite_near_duplicates.near_dup_detected_capability ? 'supported' : 'unsupported'}（改写新增行 ${B.B1.rewrite_near_duplicates.new_rows}）`, note: '实施前只有逐字主键去重' })
  unsupported.push({ item: 'B4 覆盖列', measured: B.B4.supported ? 'supported' : 'unsupported（0）', note: 'valid_from / fact_sources / assert_count 在 schema v9 不存在' })
  unsupported.push({ item: 'B5 实体列 distinct', measured: `entity_type=${B.B5.entity_type.distinct} / extraction_method=${B.B5.extraction_method.distinct}`, note: '实施前各 1' })
}
if (D) unsupported.push({ item: 'D1 写入侧密钥守卫', measured: `${(D.D1.rejection_rate * 100).toFixed(1)}%（${D.D1.rejected}/${D.D1.samples}）`, note: '实施前没有写入侧拦截' })
if (E) {
  unsupported.push({ item: 'E1 迁移一致性', measured: E.E1.applicable ? 'supported' : 'n/a', note: E.E1.reason })
  unsupported.push({ item: 'E2 不变量', measured: E.E2.applicable ? 'supported' : 'n/a', note: E.E2.reason })
  unsupported.push({ item: 'E3 WIRE_VERSION', measured: String(E.E3.wire_version), note: '实施前 2' })
}
// NEW PROBE ledger entries — labelled so a reader never mistakes them for baseline facts.
if (A5b) unsupported.push({ item: '【新增探针】A5b 带 include_scores 的逐腿原始分', measured: A5b.capability.include_scores_flag_supported ? 'supported' : 'unsupported', note: `经 rt.recall 传 include_scores=true；默认不传时 per_leg_scores_default=${A5b.capability.per_leg_scores_default}` })
if (B?.B4admin) unsupported.push({ item: '【新增探针】B4b 产品面覆盖率（admin stats）', measured: B.B4admin.product_face_supported ? 'supported' : 'unsupported', note: '来源覆盖率 / valid_from 覆盖率来自 admin.stats；assert_count>1 经 admin list+detail 交叉核对' })
if (E?.E1b) unsupported.push({ item: '【新增探针】E1b 临时副本迁移', measured: E.E1b.applicable ? (E.E1b.migrated_equals_fresh ? 'supported（与全新库一致）' : `不支持（差异 ${E.E1b.diff_parts.join('、')}）`) : `n/a（${E.E1b.reason ?? ''}）`, note: 'VACUUM INTO 快照 → 复制 → 由产品打开升级；绝不迁移活库' })
if (E?.E2b) unsupported.push({ item: '【新增探针】E2b 不变量 + 植入违规', measured: E.E2b.applicable ? (E.E2b.planted?.detected ? 'supported（植入违规被检出）' : '不支持（植入违规未被检出）') : `n/a（${E.E2b.reason ?? ''}）`, note: '调用产品 db/invariants.ts 的 validityInvariantViolations；另植入违规样本确认非永真' })

// ─── composites (spec §2) ──────────────────────────────────────────────────────
const ndcg = A1?.ndcg_at_k ?? 0
const mustInclude = A1?.summary.must_include_pass_rate ?? 0
const emptyRate = A1?.summary.empty_rate ?? 0
const mustExcludeFail = 1 - (A1?.summary.must_exclude_pass_rate ?? 0)
const quality = round4(100 * (0.35 * ndcg + 0.25 * mustInclude + 0.2 * (1 - emptyRate) + 0.2 * (1 - mustExcludeFail)))
const dedupOk = B?.B1.dedup_ok ? 1 : 0
const contraOk = B?.B2.contradiction_ok ? 1 : 0
const chainOk = B?.B3.chain_ok ? 1 : 0
const writeHealth = round4(100 * (0.4 * dedupOk + 0.3 * contraOk + 0.3 * chainOk))
const d1 = D?.D1.rejection_rate_in_design ?? D?.D1.rejection_rate ?? 0
const d1All = D?.D1.rejection_rate ?? 0
const d2 = D?.D2.false_rejection_rate ?? 0
const safety = round4(100 * (d1 * (1 - d2)))
const composites = {
  quality: A1
    ? { value: quality, inputs: { ndcg_at_k: ndcg, must_include_pass_rate: mustInclude, empty_rate: emptyRate, must_exclude_fail: round4(mustExcludeFail) } }
    : { value: null, inputs: null, note: 'A 轴未运行' },
  write_health: B
    ? { value: writeHealth, inputs: { dedup_ok: dedupOk, contradiction_ok: contraOk, chain_ok: chainOk } }
    : { value: null, inputs: null, note: 'B 轴未运行' },
  safety: D
    ? { value: safety, inputs: { d1_hit_rate: d1, d1_hit_rate_all: d1All, d2_false_reject_rate: d2, out_of_design_labels: D.D1.out_of_design_labels ?? [] } }
    : { value: null, inputs: null, note: 'D 轴未运行' },
  perf: {
    value: C ? 100 : null,
    basis: 'self-ratio for the baseline (100 × 基线 p50 / 本次 p50, no prior artifact); compare.mjs computes it against this file for the after-run',
    p50_used: C?.C1.real_snapshot.reads.stats.p50 ?? null,
  },
}

// ─── assembly ──────────────────────────────────────────────────────────────────
/**
 * The new probes this harness version adds. They are additive: each one is a NEW function whose
 * result is a NEW metric key, so no baseline metric definition moved (`HARNESS_EXTENSION.md`).
 * `compare.mjs` reads `new_probe` off the metric entries and never presents one as a delta.
 */
const newProbes = [
  { id: 'A5b', axis: 'A', title: '带 include_scores 的逐腿原始分', source: 'lib/quality.mjs runExplainabilityIncludeScores', comparability: 'corpus_drift', replaces: null, note: '既有 A5 默认探针保留不动；本条经真实 rt.recall 传 include_scores=true' },
  { id: 'B4b', axis: 'B', title: '产品面覆盖率（admin stats）', source: 'lib/quality.mjs runCoverageAdminProbe', comparability: 'corpus_drift', replaces: null, note: '既有 B4 schema 探针保留不动；本条读迁移后的 admin.stats' },
  { id: 'E1b', axis: 'E', title: '临时副本产品迁移 vs 全新库', source: 'lib/perf.mjs runIntegrityOnTempCopy', comparability: 'corpus_drift', replaces: null, note: '既有 E1 只读探针保留不动；本条只在复制品上迁移' },
  { id: 'E2b', axis: 'E', title: '产品不变量 + 植入违规非永真自检', source: 'lib/perf.mjs runIntegrityOnTempCopy', comparability: 'corpus_drift', replaces: null, note: '既有 E2 只读探针保留不动；调用产品 db/invariants.ts' },
]
const result = {
  schema: BENCH_SCHEMA,
  label,
  generated_at: new Date().toISOString(),
  elapsed_ms: Date.now() - t0,
  seed,
  pinned_now: pinnedNow,
  axis_titles: { A: '检索质量', B: '写入与生命周期', C: '性能', D: '加固与安全', E: '完整性与不变量' },
  environment: { ...environment, git },
  corpus: {
    real: corpusReal,
    synthetic: C?.synthetic_corpora ?? [],
    frozen_fixture: {
      path: 'mem/packages/core/test/fixtures/eval_zh_relations.jsonl',
      sha256: fileSha256(join(REPO, 'packages/core/test/fixtures/eval_zh_relations.jsonl')),
      queries: 41,
    },
  },
  axes: { A: { A1, A2, A3, A4, A5, A5b }, B, C, D, E },
  harness: harnessDigest(),
  metrics,
  metric_order: Object.keys(metrics),
  new_probes: newProbes,
  composites,
  unsupported,
  notes,
  reproduction: `node mem/scripts/bench/run.mjs --out ${outRel} --seed ${seed}${pinnedSnapshot ? ` --snapshot ${pinnedSnapshot}` : ''}`,
  derived_data: { tmp_root: TMP, derived_queries: tmpPath('derived-queries.json'), never_committed: true },
}

// ─── privacy gate + write ──────────────────────────────────────────────────────
const vocabulary = repoVocabulary()
const contains = containmentOracle(snap)
const privacy = gateArtifact(result, { vocabulary, contains })
result.privacy = privacy
if (!privacy.clean) {
  console.error('PRIVACY GATE FAILED — artifact not written')
  console.error(JSON.stringify({ forbidden_keys: privacy.forbidden_keys, strings_over_max: privacy.strings_over_max.slice(0, 5), pattern_hits: privacy.sensitive_pattern_hits.slice(0, 5), containment: privacy.cjk_runs_over_7_found_in_active_corpus_text.slice(0, 5) }, null, 1))
  process.exitCode = 1
} else {
  const report = renderReport(result)
  const reportGate = gateText(report, { vocabulary, contains })
  result.privacy.report = { sensitive_pattern_hits: reportGate.sensitive_pattern_hits, cjk_runs_over_7_found_in_active_corpus_text: reportGate.cjk_runs_over_7_found_in_active_corpus_text.length, clean: reportGate.clean }
  const finalGate = gateArtifact(result, { vocabulary, contains })
  if (!finalGate.clean) {
    console.error('PRIVACY GATE FAILED (final artifact) — not written')
    console.error(JSON.stringify(finalGate, null, 1).slice(0, 2000))
    process.exitCode = 1
  } else {
    writeRepoJson(outAbs, result)
    writeRepoText(reportAbs, report)
    console.log(`  wrote ${outAbs}`)
    console.log(`  wrote ${reportAbs}`)
    const cv = (k) => (composites[k].value === null ? 'n/a' : composites[k].value)
    console.log(`  composites: quality=${cv('quality')} write_health=${cv('write_health')} safety=${cv('safety')} perf=${cv('perf')}`)
  }
  if (writeDiscovery) {
    writeTmpJson('discovery.json', { label, metrics, unsupported })
  }
}

L.teardown(track)
console.log(`  elapsed ${((Date.now() - t0) / 1000).toFixed(1)}s`)
