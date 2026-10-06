#!/usr/bin/env node
/**
 * mem benchmark harness — item-by-item diff of two results.
 *
 *   node mem/scripts/bench/compare.mjs a.json b.json [--out diff.md]
 *
 * It does four things, in this order, because a diff without the first three is noise:
 *
 *   1. COMPARABILITY — classified, not global. Metrics measured on the REAL snapshot (A2/A3/A5,
 *      B4/B5, C1real/C2/C4, D3, E1/E2) are only strictly comparable when the corpus identity matches
 *      (`corpus.real.identity_sha256` + active + user_version); the DETERMINISTIC axes (frozen 41,
 *      synthetic 2k/10k, the synthetic write/lifecycle store, E3) are comparable whenever the
 *      harness schema, frozen fixture, seed, pinned clock, node and pnpm match. A real-corpus drift
 *      is reported as "语料漂移轴不可严格比较" instead of being silently diffed — and it can never
 *      yield `总体可比: true` (`HARNESS_EXTENSION.md` §可比性).
 *   2. NEW PROBES — a metric that only the later artifact has, or that carries `new_probe: true`,
 *      is listed as **新增探针** and is NEVER presented as a before→after delta.
 *   3. CRITERION CHANGE — the `harness` file digests are compared; a difference means the judgement
 *      changed, which the protocol says must be labelled (`BENCHMARK.md` §3.4).
 *   4. METRIC DIFF — every raw metric with before / after / delta / % and a direction-aware verdict,
 *      then the four composites and the "unsupported before → status after" ledger.
 *
 * `git HEAD` is deliberately INFORMATIONAL here: a before/after pair is expected to differ by
 * commit, and the spec's comparability rule is same harness + same corpus + same seed.
 */
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { LIVE_DB, WORKSPACE, containmentOracle, gateText, snapshotLive, writeRepoText } from './lib/common.mjs'

const argv = process.argv.slice(2)
const opt = (name, fallback) => {
  const i = argv.indexOf(`--${name}`)
  return i === -1 ? fallback : argv[i + 1]
}
const positional = argv.filter((a, i) => !a.startsWith('--') && !(i > 0 && argv[i - 1] === '--out'))
const [aPath, bPath] = positional
if (!aPath || !bPath) {
  console.error('usage: node mem/scripts/bench/compare.mjs <before.json> <after.json> [--out diff.md]')
  process.exit(2)
}
/** Accept a path relative to the caller's cwd first (the spec's examples are repo-root relative). */
const readJson = (p) => {
  const fromCwd = resolve(process.cwd(), p)
  const abs = existsSync(fromCwd) ? fromCwd : resolve(WORKSPACE, p)
  return JSON.parse(readFileSync(abs, 'utf8'))
}
const A = readJson(aPath)
const B = readJson(bPath)
const outPath = opt('out', null)

const fmt = (v) => {
  if (v === null || v === undefined) return 'n/a'
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : String(Math.round(v * 1e6) / 1e6)
  if (typeof v === 'boolean') return v ? 'true' : 'false'
  if (typeof v === 'string' && v.length > 24) return `${v.slice(0, 12)}…${v.slice(-6)}`
  return String(v)
}
const table = (headers, rows) => [`| ${headers.join(' | ')} |`, `| ${headers.map(() => '---').join(' | ')} |`, ...rows.map((r) => `| ${r.map(fmt).join(' | ')} |`)].join('\n')
const short = (s) => (typeof s === 'string' && s.length > 12 ? `${s.slice(0, 12)}…` : s)

/**
 * Fallback comparability class for artifacts written before `run.mjs` started tagging metrics
 * (the committed `baseline.json` has no per-metric `comparability` field). The patterns mirror the
 * classification in `run.mjs`: deterministic corpora / synthetic stores are `strict`, anything
 * measured on the real snapshot is `corpus_drift`.
 */
const STRICT_PATTERNS = [
  /^A1\./,
  /^A4\./,
  /^B1\./,
  /^B2\./,
  /^B3\./,
  /^D1\./,
  /^D2\./,
  /^E3\./,
  /^C1\.synthetic_/,
  /^C3\.build_runtime_(?:2k|10k)_ms$/,
  /^C3\.db_bytes_(?:2k|10k)$/,
  /^C3\.rss_mib_(?:2k|10k)$/,
]
const classify = (key) => (STRICT_PATTERNS.some((re) => re.test(key)) ? 'strict' : 'corpus_drift')
const classOf = (key) => {
  const bm = B.metrics[key]
  const am = A.metrics[key]
  if (bm?.new_probe || am?.new_probe) return 'new_probe'
  return bm?.comparability ?? am?.comparability ?? classify(key)
}

// ─── 1. comparability ──────────────────────────────────────────────────────────
const strictChecks = [
  ['harness schema', A.schema, B.schema],
  ['frozen fixture sha256', A.corpus.frozen_fixture?.sha256, B.corpus.frozen_fixture?.sha256],
  ['seed', A.seed, B.seed],
  ['pinned now', A.pinned_now, B.pinned_now],
  ['node', A.environment.node, B.environment.node],
  ['pnpm', A.environment.pnpm, B.environment.pnpm],
]
const strictMismatch = strictChecks.filter(([, x, y]) => x !== y).map(([n]) => n)
const strictOk = strictMismatch.length === 0

const corpusA = A.corpus.real
const corpusB = B.corpus.real
const snapA = corpusA.identity_sha256 ?? corpusA.snapshot_sha256
const snapB = corpusB.identity_sha256 ?? corpusB.snapshot_sha256
const liveA = corpusA.live_sha256 ?? null
const liveB = corpusB.live_sha256 ?? null
const bothLive = Boolean(liveA && liveB)
const snapshotOk = snapA === snapB
/**
 * The snapshot is the ONLY trustworthy corpus identity: `VACUUM INTO` reads the logical store
 * (WAL included), while `fileSha256(memory.db)` is the main file and goes STALE whenever recent
 * writes still sit in the `-wal` sidecar (measured: the live sha stayed 343a4fd5… across the 86→88
 * drift). So the live sha is informational, never an alternative identity.
 */
const identityOk = snapshotOk
const corpusMismatch = []
if (!identityOk) corpusMismatch.push('corpus identity sha256')
if (corpusA.active !== corpusB.active) corpusMismatch.push('active facts')
if (corpusA.user_version !== corpusB.user_version) corpusMismatch.push('user_version')
const corpusOk = corpusMismatch.length === 0
const driftDescription = corpusOk
  ? '真实语料身份一致，语料漂移轴可严格比较'
  : `真实语料已漂移（${corpusMismatch.join('、')}；active ${fmt(corpusA.active)}→${fmt(corpusB.active)}，identity ${short(snapA)}→${short(snapB)}）⇒ 该轴不可严格比较`
const infoChecks = [
  ['git HEAD', A.environment.git.head, B.environment.git.head],
  ['harness digest', A.harness?.digest, B.harness?.digest],
  ['snapshot sha256', corpusA.snapshot_sha256, corpusB.snapshot_sha256],
  ['corpus 来源', corpusA.corpus_source ?? 'live-vacuum-into', corpusB.corpus_source ?? 'live-vacuum-into'],
]
const harnessSame = A.harness?.digest === B.harness?.digest
const synthKey = (r) => (r.corpus.synthetic ?? []).map((s) => `${s.rows}:${s.content_sha256}`).sort().join(',')
const synthSame = synthKey(A) === synthKey(B)
const synthBoth = (A.corpus.synthetic?.length ?? 0) > 0 && (B.corpus.synthetic?.length ?? 0) > 0
/** `null` = the synthetic corpora were not measured on one side (C axis not run). */
const syntheticOk = synthBoth ? synthSame : null
/** Synthetic-corpus metrics are the only strict-axis rows that additionally need the corpus pin. */
const isSyntheticMetric = (k) => /^C1\.synthetic_/.test(k)
  || /^C3\.build_runtime_(?:2k|10k)_ms$/.test(k)
  || /^C3\.db_bytes_(?:2k|10k)$/.test(k)
  || /^C3\.rss_mib_(?:2k|10k)$/.test(k)
const comparable = strictOk && corpusOk && syntheticOk !== false

// Axis coverage differs when only some axes were run (`--axes`). A metric is only "removed" when
// its axis was measured on BOTH sides; an unrun axis is reported as unrun, not as a criterion change.
const axisSet = (r) => new Set(Object.values(r.metrics ?? {}).map((m) => m.axis))
const axesA = axisSet(A)
const axesB = axisSet(B)
const unrunByB = [...axesA].filter((a) => !axesB.has(a)).sort()
const unrunByA = [...axesB].filter((a) => !axesA.has(a)).sort()

// ─── 2. metric diff (+ new-probe split) ────────────────────────────────────────
const keys = [...new Set([...(A.metric_order ?? Object.keys(A.metrics)), ...(B.metric_order ?? Object.keys(B.metrics))])]
const addedKeys = keys.filter((k) => !A.metrics[k] && B.metrics[k])
const axisOfKey = (k) => B.metrics[k]?.axis ?? A.metrics[k]?.axis
const removedKeys = keys.filter((k) => A.metrics[k] && !B.metrics[k] && axesB.has(axisOfKey(k)))
const newProbeKeys = keys.filter((k) => classOf(k) === 'new_probe' || addedKeys.includes(k))
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const rowsByAxis = {}
const newRowsByAxis = {}
let counts = { better: 0, worse: 0, same: 0, info: 0 }
for (const k of keys) {
  const am = A.metrics[k] ?? {}
  const bm = B.metrics[k] ?? {}
  const av = am.value ?? null
  const bv = bm.value ?? null
  const axis = (am.axis ?? bm.axis ?? '?')
  const dir = am.direction ?? bm.direction ?? 'neutral'
  const cls = classOf(k)
  const isNew = cls === 'new_probe'
  if (isNew) {
    ;(newRowsByAxis[axis] ??= []).push([k, av, bv, '新增探针'])
    continue
  }
  const axisUnrun = !axesB.has(axis)
  const comparableRow = !axisUnrun && (cls === 'strict'
    ? (strictOk && (!isSyntheticMetric(k) || syntheticOk !== false))
    : (strictOk && corpusOk))
  const an = num(av)
  const bn = num(bv)
  const delta = an !== null && bn !== null ? Math.round((bn - an) * 1e6) / 1e6 : null
  const pct = an !== null && bn !== null && an !== 0 ? Math.round(((bn - an) / Math.abs(an)) * 1e6) / 1e6 : null
  let verdict = 'info'
  if (axisUnrun) verdict = '未运行'
  else if (!comparableRow) verdict = '不可比'
  else if (av === bv) verdict = 'same'
  else if (an !== null && bn !== null) {
    if (dir === 'higher_better') verdict = bn > an ? 'better' : 'worse'
    else if (dir === 'lower_better') verdict = bn < an ? 'better' : 'worse'
    else verdict = 'info'
  }
  if (comparableRow) counts[verdict] += 1
  const mark = axisUnrun ? '未运行' : comparableRow ? '' : (cls === 'strict' ? '不可比（严格口径）' : '不可比（语料漂移）')
  ;(rowsByAxis[axis] ??= []).push([k, av, bv, delta, pct === null ? 'n/a' : `${(pct * 100).toFixed(1)}%`, dir, verdict, mark])
}

// ─── 3. composites ─────────────────────────────────────────────────────────────
const COMPOSITE_CLASS = { quality: 'strict', write_health: 'strict', safety: 'strict', perf: 'corpus_drift' }
const perfAfter = (() => {
  const a = A.metrics['C1.real_snapshot.p50_ms']?.value
  const b = B.metrics['C1.real_snapshot.p50_ms']?.value
  if (typeof a !== 'number' || typeof b !== 'number' || b === 0) return null
  return Math.round(Math.min(100, (a / b) * 100) * 1e4) / 1e4
})()
const composites = Object.keys(A.composites).map((k) => {
  const av = A.composites[k].value
  const bv = k === 'perf' ? (perfAfter ?? B.composites[k].value) : B.composites[k].value
  const cls = COMPOSITE_CLASS[k] ?? 'strict'
  const ok = cls === 'strict' ? strictOk : (strictOk && corpusOk)
  const delta = bv !== null && av !== null ? Math.round((bv - av) * 1e4) / 1e4 : null
  return [k, av, bv, ok ? delta : '不可比', cls === 'strict' ? '严格可比轴' : '语料漂移轴']
})

// ─── 4. unsupported ledger ─────────────────────────────────────────────────────
const aUnsup = new Map((A.unsupported ?? []).map((u) => [u.item, u.measured]))
const bUnsup = new Map((B.unsupported ?? []).map((u) => [u.item, u.measured]))
const ledger = [...new Set([...aUnsup.keys(), ...bUnsup.keys()])].map((k) => [
  k,
  aUnsup.get(k) ?? 'n/a',
  bUnsup.get(k) ?? 'n/a',
  aUnsup.has(k) ? '' : '新增探针',
])

// ─── render ────────────────────────────────────────────────────────────────────
const L = []
L.push(`# mem 基准差异 · ${A.label} → ${B.label}`)
L.push('')
L.push(`> ${A.generated_at} → ${B.generated_at}`)
L.push('')
L.push('## 1. 可比性')
L.push('')
L.push('### 1.1 严格可比轴（判据口径）')
L.push('')
L.push(table(['检查', A.label, B.label, '一致'], strictChecks.map(([n, x, y]) => [n, x, y, x === y])))
L.push('')
L.push(table(['信息项（不参与判定）', A.label, B.label, '一致'], infoChecks.map(([n, x, y]) => [n, x, y, x === y])))
L.push('')
L.push('### 1.2 语料漂移轴（真实语料身份）')
L.push('')
L.push(table(['检查', A.label, B.label, '一致'], [
  ['corpus identity sha256', snapA, snapB, snapshotOk],
  ['live db sha256', liveA ?? 'n/a（固定副本）', liveB ?? 'n/a（固定副本）', bothLive ? liveA === liveB : 'info'],
  ['active facts', corpusA.active, corpusB.active, corpusA.active === corpusB.active],
  ['user_version', corpusA.user_version, corpusB.user_version, corpusA.user_version === corpusB.user_version],
]))
L.push('')
L.push('> `live db sha256` 只是 `memory.db` 主库文件的 sha：写入还在 `-wal` 侧车文件里时它会**滞后**，所以它只作信息项，**不参与判定**——语料身份以 `VACUUM INTO` 快照（`identity sha256`）为准。')
L.push('')
L.push(`- ${driftDescription}`)
L.push(`- 严格可比轴（判据口径）: **${strictOk}**`)
L.push(`- 合成语料（2k/10k）: **${syntheticOk === null ? '未在两侧都测到（C 轴未运行）' : syntheticOk}**`)
L.push(`- 语料漂移轴（真实快照）: **${corpusOk}**`)
L.push(`- 总体可比（= 严格口径 + 合成语料 + 语料轴）: **${comparable}**`)
L.push(`- harness 判据一致: **${harnessSame}**${harnessSame ? '' : '（**判据已变**）'}`)
if (unrunByB.length) L.push(`- 轴覆盖：${B.label} 未运行 ${unrunByB.join('、')} 轴（这些轴的指标不参与差异，也不算"消失"）`)
if (unrunByA.length) L.push(`- 轴覆盖：${A.label} 未运行 ${unrunByA.join('、')} 轴`)
if (!harnessSame) {
  const onlyAdds = removedKeys.length === 0 && addedKeys.length > 0
  L.push(`  - 新增指标（新增探针）: ${addedKeys.length ? `${addedKeys.length} 个：${addedKeys.map((k) => `\`${k}\``).join('、')}` : '无'}`)
  L.push(`  - 两侧都测到却消失的指标: ${removedKeys.length ? removedKeys.map((k) => `\`${k}\``).join('、') : '无'}`)
  L.push(`  - 结论: ${onlyAdds ? '判据已变 —— **仅新增探针**（既有指标未移除；新探针结果只列 §3.1，不得当作 delta）' : '判据已变 —— 有指标消失/疑似口径变化，既有指标差异仅供参考'}`)
}
if (strictMismatch.length) L.push(`- 严格口径不一致项: ${strictMismatch.join('、')}`)
if (corpusMismatch.length) L.push(`- 语料漂移不一致项: ${corpusMismatch.join('、')}`)
L.push('')

// per-axis comparability
const axisNames = [...new Set([...Object.keys(rowsByAxis), ...Object.keys(newRowsByAxis)])].sort()
L.push('### 1.3 按轴可比性')
L.push('')
L.push(table(['轴', '严格可比指标', '语料漂移指标', '新增探针', '结论'], axisNames.map((axis) => {
  const rows = rowsByAxis[axis] ?? []
  const strictN = rows.filter((r) => classOf(r[0]) === 'strict').length
  const driftN = rows.length - strictN
  const newN = (newRowsByAxis[axis] ?? []).length
  if (!axesB.has(axis)) return [axis, strictN, driftN, newN, '未运行（B 侧无指标）']
  const driftConclusion = driftN === 0 ? '无漂移指标' : (corpusOk ? '漂移轴可比' : '**该轴不可严格比较**（语料漂移）')
  return [axis, strictN, driftN, newN, driftConclusion]
})))
if (newProbeKeys.length) {
  L.push('')
  L.push('新增探针清单（基线与本次都没有 delta 语义）：')
  for (const k of newProbeKeys) L.push(`- \`${k}\``)
}
L.push('')
L.push('## 2. 逐项差异')
L.push('')
L.push('> 新增探针不在本表；它们列在 §1.3 与 §3.1，永远不作为 delta。')
L.push('')
for (const axis of Object.keys(rowsByAxis).sort()) {
  L.push(`### ${axis} 轴`)
  L.push('')
  L.push(table(['指标', A.label, B.label, 'Δ', 'Δ%', '方向', '判定', '可比'], rowsByAxis[axis]))
  L.push('')
}
L.push(`判定汇总（仅计可比项）：better ${counts.better} / worse ${counts.worse} / same ${counts.same} / info ${counts.info}`)
L.push('')
if (Object.keys(newRowsByAxis).length) {
  L.push('## 3.1 新增探针结果（不与基线做 delta）')
  L.push('')
  for (const axis of Object.keys(newRowsByAxis).sort()) {
    L.push(`**${axis} 轴**`)
    L.push('')
    L.push(table(['指标', A.label, B.label, '说明'], newRowsByAxis[axis]))
    L.push('')
  }
}
L.push('## 3. composite（仅趋势）')
L.push('')
L.push(table(['composite', A.label, B.label, 'Δ', '可比性'], composites))
L.push('')
L.push('## 4. 实施前应为 0 / 不支持的项')
L.push('')
L.push(table(['项', A.label, B.label, '备注'], ledger))
L.push('')
const md = `${L.join('\n')}\n`
if (outPath) {
  // A repo product goes through the same screen as the harness artifacts: zero sensitive-pattern
  // hits and zero 8+ char CJK runs that occur in the live corpus text (checked in-process only).
  const patternGate = gateText(md)
  let containment = []
  if (existsSync(LIVE_DB)) {
    const dir = mkdtempSync(join(tmpdir(), 'avantf-bench-cmp-'))
    try {
      containment = gateText(md, { contains: containmentOracle(snapshotLive(dir)) }).cjk_runs_over_7_found_in_active_corpus_text
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }
  if (!patternGate.clean || containment.length > 0) {
    console.error('PRIVACY GATE FAILED — diff not written')
    console.error(JSON.stringify({ sensitive_pattern_hits: patternGate.sensitive_pattern_hits.slice(0, 5), containment: containment.slice(0, 5) }, null, 1))
    process.exitCode = 1
  } else {
    const p = writeRepoText(resolve(WORKSPACE, outPath), md)
    console.log(`wrote ${p}`)
  }
} else {
  console.log(md)
}
if (!comparable) process.exitCode = 1
