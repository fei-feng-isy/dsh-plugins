/**
 * Round-4 shared scaffolding — the REAL-CORPUS campaign's privacy boundary and the few helpers
 * every R4 card needs. It deliberately does NOT re-implement the retrieval reproduction: that is
 * `bench-spike-lib.mjs`, which this module imports and re-exports where useful (the brief forbids
 * changing the first-three-round scripts).
 *
 * WHAT IS DIFFERENT ABOUT ROUND 4. Rounds 1–3 never touched the live text; round 4 annotates it.
 * The data root (`~/.avantf/memory`) is a git repository with a gitee remote, so ANY string derived
 * from fact text that lands under `mem/**` is one `git push` away from leaving the machine. This
 * module is the single place that enforces the boundary:
 *
 *   1. **Text may exist only in `/tmp`** ({@link tmpPath} / {@link writeTmp}). Every derived string
 *      (annotation entity names, query texts, labels) goes there.
 *   2. **Repo artifacts are aggregates only** — ids, lengths, scores, counts, ratios, hashes.
 *      {@link auditArtifact} rejects a `text`/`content`/`body` key, an over-long string, a
 *      sensitive-pattern hit, or an un-whitelisted CJK run of 8+ characters.
 *   3. **The whitelist is the pre-existing public repo vocabulary** ({@link repoCjkWhitelist}): a
 *      CJK run already present in the committed campaign documents cannot be a new leak. Anything
 *      else 8+ characters long is reported for manual review.
 *   4. **The 46 sensitive patterns** are transcribed from
 *      `hindsight-api-slim/hindsight_api/extensions/memory_defense.py` (`_REDACTION_PATTERNS`,
 *      lines 167–238 as of 2026-10-06 — the round-4 brief says "44"; the file carries 46 and we
 *      scan with the superset). The `credit_card` rule keeps the source's Luhn second pass.
 *
 * HONEST BOUNDARY. `auditArtifact` is a KEY-LEVEL and STRING-LEVEL screen, not a proof that no
 * aggregate can be inverted. It is the strongest offline check available and the report states the
 * residual explicitly.
 *
 * @module scripts/spikes/bench-r4-lib
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as L from './bench-spike-lib.mjs'

export const R4_TMP = join(tmpdir(), 'dsh-r4')
export const tmpPath = (name) => join(R4_TMP, name)
export function ensureTmp() {
  mkdirSync(R4_TMP, { recursive: true })
  return R4_TMP
}
export function writeTmp(name, obj) {
  ensureTmp()
  const p = tmpPath(name)
  writeFileSync(p, JSON.stringify(obj, null, 1))
  console.log(`  (derived data -> ${p}; never committed)`)
  return p
}
export function readTmp(name) {
  const p = tmpPath(name)
  if (!existsSync(p)) throw new Error(`round4: missing derived artifact ${p} — the annotation/query step has not run`)
  return JSON.parse(readFileSync(p, 'utf8'))
}

// ─── the round-1/round-2 Chinese time-window parser (copied, not imported: importing R2-2 would
//     run its whole benchmark) ────────────────────────────────────────────────────────────────────
export const DAY = 86_400_000
const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate())
const startOfWeek = (d) => {
  const day = (d.getDay() + 6) % 7
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - day)
}
/** One window per call; `now` is injectable so a card can pin the clock and stay reproducible. */
export function parseTimeWindow(text, now = new Date()) {
  const q = text
  const day0 = startOfDay(now)
  let m = q.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/)
  if (m) {
    const s = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
    return { start: s.getTime(), end: s.getTime() + DAY, rule: 'yyyy年m月d日', matched: m[0] }
  }
  m = q.match(/(\d{4})[-/](\d{1,2})[-/](\d{1,2})/)
  if (m) {
    const s = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]))
    return { start: s.getTime(), end: s.getTime() + DAY, rule: 'yyyy-m-d', matched: m[0] }
  }
  m = q.match(/(\d{4})年(\d{1,2})月(?!\d)/)
  if (m) {
    const s = new Date(Number(m[1]), Number(m[2]) - 1, 1)
    return { start: s.getTime(), end: new Date(s.getFullYear(), s.getMonth() + 1, 1).getTime(), rule: 'yyyy年m月', matched: m[0] }
  }
  m = q.match(/(\d{1,2})月(\d{1,2})日/)
  if (m) {
    const s = new Date(now.getFullYear(), Number(m[1]) - 1, Number(m[2]))
    return { start: s.getTime(), end: s.getTime() + DAY, rule: 'm月d日(current year)', matched: m[0] }
  }
  m = q.match(/最近\s*(\d+)\s*(天|日)/)
  if (m) return { start: now.getTime() - Number(m[1]) * DAY, end: now.getTime(), rule: '最近N天', matched: m[0] }
  if (/最近\s*(一周|一星期|7天|七天)/.test(q)) return { start: now.getTime() - 7 * DAY, end: now.getTime(), rule: '最近一周', matched: '最近一周' }
  if (/最近\s*(一个月|1个月|30天|三十天)/.test(q)) return { start: now.getTime() - 30 * DAY, end: now.getTime(), rule: '最近一个月', matched: '最近一个月' }
  if (/今天|今日/.test(q)) return { start: day0.getTime(), end: day0.getTime() + DAY, rule: '今天', matched: '今天' }
  if (/昨天|昨日/.test(q)) return { start: day0.getTime() - DAY, end: day0.getTime(), rule: '昨天', matched: '昨天' }
  if (/前天/.test(q)) return { start: day0.getTime() - 2 * DAY, end: day0.getTime() - DAY, rule: '前天', matched: '前天' }
  if (/本周|这周|本星期/.test(q)) {
    const s = startOfWeek(now)
    return { start: s.getTime(), end: s.getTime() + 7 * DAY, rule: '本周', matched: '本周' }
  }
  if (/上周|上星期|上个星期/.test(q)) {
    const s = startOfWeek(now)
    return { start: s.getTime() - 7 * DAY, end: s.getTime(), rule: '上周', matched: '上周' }
  }
  if (/上个月|上月/.test(q)) {
    const s = new Date(now.getFullYear(), now.getMonth() - 1, 1)
    const e = new Date(now.getFullYear(), now.getMonth(), 1)
    return { start: s.getTime(), end: e.getTime(), rule: '上个月', matched: '上个月' }
  }
  if (/这个月|本月/.test(q)) {
    const s = new Date(now.getFullYear(), now.getMonth(), 1)
    return { start: s.getTime(), end: new Date(now.getFullYear(), now.getMonth() + 1, 1).getTime(), rule: '这个月', matched: '这个月' }
  }
  if (/去年/.test(q)) {
    const s = new Date(now.getFullYear() - 1, 0, 1)
    return { start: s.getTime(), end: new Date(now.getFullYear(), 0, 1).getTime(), rule: '去年', matched: '去年' }
  }
  if (/今年/.test(q)) {
    const s = new Date(now.getFullYear(), 0, 1)
    return { start: s.getTime(), end: new Date(now.getFullYear() + 1, 0, 1).getTime(), rule: '今年', matched: '今年' }
  }
  return undefined
}

/** Every time expression in a text (the S1 "usable event time" scan needs all of them, not the first). */
export function allTimeExpressions(text, now = new Date()) {
  const out = []
  const patterns = [
    /(\d{4})年(\d{1,2})月(\d{1,2})日/g,
    /(\d{4})[-/](\d{1,2})[-/](\d{1,2})/g,
    /(\d{4})年(\d{1,2})月(?!\d)/g,
    /(\d{1,2})月(\d{1,2})日/g,
    /最近\s*(\d+)\s*(天|日)/g,
    /最近\s*(一周|一星期|7天|七天)/g,
    /最近\s*(一个月|1个月|30天|三十天)/g,
    /(今天|今日|昨天|昨日|前天|本周|这周|本星期|上周|上星期|上个星期|上个月|上月|这个月|本月|去年|今年)/g,
  ]
  for (const re of patterns) {
    for (const m of text.matchAll(re)) {
      const win = parseTimeWindow(m[0], now)
      if (win) out.push({ matched: m[0], rule: win.rule, start: win.start, end: win.end })
    }
  }
  // A longer match subsumes a shorter one that starts at the same offset (e.g. yyyy年m月d日 vs m月d日).
  const seen = new Set()
  return out.filter((e) => {
    const k = `${e.matched}@${e.start}`
    if (seen.has(k)) return false
    seen.add(k)
    return true
  })
}

// ─── CJK helpers ────────────────────────────────────────────────────────────────────────────────
export const CJK_CHAR_RE = /[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/
export const CJK_RUN_RE = /[\u3400-\u4dbf\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]+/g
export const cjkRuns = (s) => String(s).match(CJK_RUN_RE) ?? []

/** NFKC + case fold + whitespace removal — the "folded synonym" first stage (not a synonym table). */
export function normName(s) {
  return String(s).normalize('NFKC').toLowerCase().replace(/[\s\u3000]+/g, '')
}

// ─── the sensitive-pattern screen (transcribed from memory_defense.py `_REDACTION_PATTERNS`) ─────
const A_START = '(?<![A-Za-z0-9_])'
const A_END = '(?![A-Za-z0-9_])'
const a = (body) => ({ src: `${A_START}${body}${A_END}`, flags: '' })
const raw = (src, flags = '') => ({ src, flags })
export const SENSITIVE_PATTERNS = [
  ['anthropic_key', a('sk-ant-[A-Za-z0-9_-]{20,}')],
  ['openai_project_key', a('sk-proj-[A-Za-z0-9_-]{48,}')],
  ['openai_admin_key', a('sk-admin-[A-Za-z0-9_-]{40,}')],
  ['openai_key', a('sk-[A-Za-z0-9_-]{20,}')],
  ['google_api_key', a('AIza[0-9A-Za-z_-]{35}')],
  ['google_oauth_token', a('ya29\\.[0-9A-Za-z_-]{20,}')],
  ['xai_key', a('xai-[A-Za-z0-9]{40,}')],
  ['groq_key', a('gsk_[A-Za-z0-9]{20,}')],
  ['hindsight_key', a('hsk_(?:sys_)?[0-9a-f]{32}(?:_[0-9a-f]{8,})?')],
  ['huggingface_token', a('hf_[A-Za-z0-9]{30,}')],
  ['replicate_token', a('r8_[A-Za-z0-9]{30,}')],
  ['perplexity_key', a('pplx-[A-Za-z0-9]{40,}')],
  ['databricks_token', a('dapi[A-Za-z0-9]{32}')],
  ['aws_access_key', a('AKIA[0-9A-Z]{16}')],
  ['aws_session_token', a('ASIA[0-9A-Z]{16}')],
  ['aws_secret_key', raw('aws(.{0,20})?(secret|private)?[\\s_-]?access[\\s_-]?key[\\s_-]?[:=][\\s"\']*([A-Za-z0-9/+=]{40})', 'i')],
  ['digitalocean_token', a('dop_v1_[a-f0-9]{64}')],
  ['github_fg_pat', a('github_pat_[A-Za-z0-9_]{60,}')],
  ['github_token', a('ghp_[A-Za-z0-9]{36}')],
  ['github_app_token', a('ghs_[A-Za-z0-9]{36}')],
  ['github_user_token', a('ghu_[A-Za-z0-9]{36}')],
  ['github_refresh', a('ghr_[A-Za-z0-9]{36}')],
  ['github_oauth', a('gho_[A-Za-z0-9]{36}')],
  ['gitlab_pat', a('glpat-[A-Za-z0-9_-]{20,}')],
  ['npm_token', a('npm_[A-Za-z0-9]{30,}')],
  ['pypi_token', a('pypi-AgEIcHlwaS5vcmc[A-Za-z0-9_-]{20,}')],
  ['stripe_secret', a('sk_(?:live|test)_[A-Za-z0-9]{20,}')],
  ['stripe_restricted', a('rk_(?:live|test)_[A-Za-z0-9]{20,}')],
  ['square_token', a('sq0[a-z]{3}-[A-Za-z0-9_-]{22,}')],
  ['braintree_token', a('access_token\\$production\\$[a-z0-9]{16}\\$[a-f0-9]{32}')],
  ['slack_token', a('xox[abpr]-[0-9A-Za-z-]{10,}')],
  ['slack_webhook', raw('https://hooks\\.slack\\.com/services/T[A-Za-z0-9_]{8,}/B[A-Za-z0-9_]{8,}/[A-Za-z0-9_]{20,}')],
  ['twilio_api_key', a('SK[0-9a-fA-F]{32}')],
  ['twilio_account_sid', a('AC[0-9a-fA-F]{32}')],
  ['sendgrid_key', a('SG\\.[A-Za-z0-9_-]{22}\\.[A-Za-z0-9_-]{43}')],
  ['mailgun_key', a('key-[A-Za-z0-9]{32}')],
  ['discord_bot', a('[MNO][A-Za-z0-9]{23}\\.[A-Za-z0-9_-]{6}\\.[A-Za-z0-9_-]{27}')],
  ['telegram_bot', a('[0-9]{8,10}:[A-Za-z0-9_-]{35}')],
  ['shopify_token', a('shpat_[a-fA-F0-9]{32}')],
  ['db_url_postgres', raw('postgres(?:ql)?://[^\\s:/@]+:[^\\s/@]+@[^\\s]+')],
  ['db_url_mysql', raw('mysql://[^\\s:/@]+:[^\\s/@]+@[^\\s]+')],
  ['db_url_mongodb', raw('mongodb(?:\\+srv)?://[^\\s:/@]+:[^\\s/@]+@[^\\s]+')],
  ['private_key_pem', raw('-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY( BLOCK)?-----')],
  ['jwt', a('eyJ[A-Za-z0-9_-]{10,}\\.eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}')],
  ['credit_card', a('(?<!\\d)(?<!\\d\\.)(?:\\d{4}[ -]?){3}\\d{1,4}(?!\\d)(?!\\.\\d)')],
  ['ssn_us', a('\\d{3}-\\d{2}-\\d{4}')],
  ['uuid', raw('[0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}')],
]

const luhn = (value) => {
  const digits = value.replace(/\D/g, '')
  if (digits.length < 13 || digits.length > 16) return false
  let sum = 0
  let alt = false
  for (let i = digits.length - 1; i >= 0; i -= 1) {
    let d = Number(digits[i])
    if (alt) {
      d *= 2
      if (d > 9) d -= 9
    }
    sum += d
    alt = !alt
  }
  return sum % 10 === 0
}

/** All sensitive-pattern hits in one string (label + masked span; the span itself is never returned raw-length-preserving). */
export function scanSensitiveStrings(text) {
  const hits = []
  for (const [label, { src, flags }] of SENSITIVE_PATTERNS) {
    const re = new RegExp(src, flags.includes('g') ? flags : `${flags}g`)
    for (const m of String(text).matchAll(re)) {
      if (label === 'credit_card' && !luhn(m[0])) continue
      hits.push({ label, index: m.index, length: m[0].length })
    }
  }
  return hits
}

// ─── artifact audit (the "repo products are aggregates only" gate) ──────────────────────────────
const FORBIDDEN_KEYS = new Set(['text', 'content', 'body', 'excerpt', 'snippet', 'passage', 'quote', 'raw_text'])
const MAX_STRING = 300

/** Collect every string value / key path in a JSON value. */
function walk(value, path, visit) {
  if (typeof value === 'string') visit(value, path)
  else if (Array.isArray(value)) value.forEach((v, i) => walk(v, `${path}[${i}]`, visit))
  else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      if (FORBIDDEN_KEYS.has(k.toLowerCase())) visit(`\u0000KEY:${path}.${k}`, `${path}.${k}`)
      walk(v, `${path}.${k}`, visit)
    }
  }
}

/**
 * Audit one artifact object. `cjkWhitelist` is a Set of 8+ char CJK runs that already exist in the
 * committed campaign documents; anything else that long is surfaced for review.
 */
export function auditArtifact(obj, { cjkWhitelist = null, maxString = MAX_STRING } = {}) {
  const forbiddenKeys = []
  const longStrings = []
  const patternHits = []
  const cjkUnknown = []
  walk(obj, '$', (s, path) => {
    if (path.startsWith('\u0000KEY:')) {
      forbiddenKeys.push(path.slice(5))
      return
    }
    if (s.length > maxString) longStrings.push({ path, length: s.length })
    for (const h of scanSensitiveStrings(s)) patternHits.push({ path, ...h })
    if (cjkWhitelist) for (const run of cjkRuns(s)) if (run.length >= 8 && !cjkWhitelist.has(run)) cjkUnknown.push({ path, length: run.length, run })
  })
  return {
    clean: forbiddenKeys.length === 0 && longStrings.length === 0 && patternHits.length === 0 && cjkUnknown.length === 0,
    forbidden_keys: forbiddenKeys,
    strings_over_max: longStrings,
    sensitive_pattern_hits: patternHits,
    cjk_runs_over_7_not_whitelisted: cjkUnknown,
    keys_checked: true,
  }
}

/**
 * The 8+ char CJK vocabulary that already exists in the COMMITTED campaign documents. A run found
 * here is public repository text already, so it can never be a new leak; everything else is a
 * string this round produced and must be reviewed.
 */
export function repoCjkWhitelist() {
  const files = []
  const spikes = join(L.REPO, 'docs/spikes')
  if (existsSync(spikes)) for (const f of readdirSync(spikes)) if (f.endsWith('.md')) files.push(join(spikes, f))
  for (const extra of ['docs/BORROWABLE_IMPROVEMENTS.md', 'docs/IMPROVEMENT_IMPACT_ANALYSIS.md']) {
    const p = join(L.REPO, extra)
    if (existsSync(p)) files.push(p)
  }
  const rootAgents = join(L.REPO, '..', 'AGENTS.md')
  if (existsSync(rootAgents)) files.push(rootAgents)
  const out = new Set()
  for (const f of files) for (const run of cjkRuns(readFileSync(f, 'utf8'))) if (run.length >= 8) out.add(run)
  return out
}

/** Remove a temp file/dir (round-4 convention: `teardown` also clears the derived artifacts on request). */
export function rm(path) {
  rmSync(path, { recursive: true, force: true })
}

export { L }
// Re-export the first-three-round scaffolding helpers the R4 cards use, so a card can import one
// module (`bench-r4-lib.mjs`) and still reach the shared snapshot/runtime/identity machinery.
export const {
  banner, arg, hasFlag, writeJson, snapshotDb, openReadOnly, openWritable, loadActiveTexts,
  newRuntime, warmEmbedder, identityCheck, runScript, prodResult, sameOrder, teardown,
  resolveRealGolds, frozenCases, makeEvalRetriever, degradedSemantic, rssMiB,
  REAL_QUERIES, DEFAULT_DB, REPO, lib: libPath,
} = L
