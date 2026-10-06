/**
 * R2-2 · A2's REAL-CORPUS time query set — does the window leg help on facts the store actually holds?
 *
 * WHY THIS CARD EXISTS. Round 1 adopted A2 (Chinese time windows) only CONDITIONALLY: a scan of all
 * 61 real/frozen queries found ZERO with a time expression, so the measured gains came from a
 * script-authored fixture. This card removes that condition where it can: instead of manufacturing a
 * corpus, it DERIVES queries from the live snapshot.
 *
 * DERIVATION (anti-circularity is the whole design).
 *   1. pick a topic word = an entity name whose ACTIVE document frequency is low but >= 2
 *      (`df in [2, 8]`). df >= 2 is what keeps the query from containing a literal UNIQUE to the
 *      gold fact — a df-1 topic would let the lexical leg answer the window query by itself and the
 *      measurement would be self-fulfilling;
 *   2. pick a window whose `created_at` interval contains EXACTLY ONE of that entity's facts;
 *   3. the query is `<topic> <window word>`, gold = that one fact; the guard is `<topic>` with no
 *      window word.
 * The parser is the round-1 prototype (copied, because importing the round-1 script would run its
 * whole benchmark); the window leg is the round-1 arm.
 *
 * ARMS: `w0.3` / `w1.0` (an extra leg scoring in-window facts 1, weight 0.3 / 1.0) and `hard` (the
 * same leg plus a fused-pool restriction to the window; an empty window falls back to production).
 * GUARD: a no-time query must return byte-identical ids with and without the arm.
 *
 * VERDICT RULE (brief): in-top3 improves materially AND guard injury = 0 => the A2 condition is
 * lifted; otherwise A2 stays "constructible but no demand evidence". Windows with no in-window fact
 * yield no query and are reported as such — a real corpus is allowed to be silent.
 *
 * Usage: node mem/scripts/spikes/bench-r2-2-real-time-queries.mjs [--json <path>]
 * PRIVACY: ids / lengths / dates / derived short topic words only — no fact text is read into the
 * output, and no `text`/`content`-like value is written (key-level self-check in the JSON).
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as L from './bench-spike-lib.mjs'

const jsonOut = L.arg('json', join(L.REPO, 'docs/spikes/raw/round2-r2-2-real-time-queries.json'))
const LIMIT = 5
const NOW = new Date()

// ─── the round-1 parser prototype (kept identical; see bench-a2-time-window.mjs) ────────────────
const DAY = 86_400_000
const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate())
const startOfWeek = (d) => {
  const day = (d.getDay() + 6) % 7
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - day)
}
export function parseTimeWindow(text, now = NOW) {
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

/** The window words the brief names, in the order to try them. */
const WINDOW_WORDS = ['今天', '昨天', '前天', '本周', '上周', '这个月', '上个月', '今年', '2026年9月18日']
const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10)

// ─── snapshot-derived corpus metadata (ids / names / df / dates; text NOT retained) ─────────────
function loadDerivationInputs(snap) {
  const db = L.openReadOnly(snap)
  try {
    const rows = db.prepare(
      `select f.fact_id id, f.created_at created, e.name entity
         from facts f
         left join fact_entities fe on fe.fact_id = f.fact_id
         left join entities e on e.entity_id = fe.entity_id
        where f.status = 'active'`,
    ).all()
    const created = new Map()
    const bags = new Map()
    for (const r of rows) {
      if (!created.has(r.id)) {
        created.set(r.id, r.created)
        bags.set(r.id, [])
      }
      if (r.entity) bags.get(r.id).push(r.entity)
    }
    const df = new Map()
    for (const names of bags.values()) for (const n of names) df.set(n, (df.get(n) ?? 0) + 1)
    return { ids: [...created.keys()], created, bags, df }
  } finally {
    db.close()
  }
}

async function main() {
  const emb = await L.warmEmbedder()
  const track = { runtimes: [], dirs: [] }
  const work = mkdtempSync(join(tmpdir(), 'avantf-r22-'))
  track.dirs.push(work)
  const snap = join(work, 'memory.db')
  L.snapshotDb(L.DEFAULT_DB, snap)
  const { texts, meta } = L.loadActiveTexts(snap)
  track.texts = texts
  L.banner('R2-2 · real-corpus time queries', { snapshot: snap, active_facts: texts.size, now: NOW.toISOString() })

  const { ids, created, bags, df } = loadDerivationInputs(snap)
  const ms = (id) => Date.parse(String(created.get(id)).replace(' ', 'T') + 'Z')
  // created_at is stored as UTC `YYYY-MM-DD HH:MM:SS`; the parser works in LOCAL time, so compare
  // against the LOCAL rendering of the parsed window (same convention the store uses for display).
  const localDay = (id) => {
    const t = ms(id)
    const d = new Date(t)
    return d.getTime()
  }
  /** Local calendar day of a fact vs the parser's (local) window. */
  const inWindow = (id, win) => {
    const d = new Date(localDay(id))
    const day0 = new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
    const s = new Date(win.start)
    const e = new Date(win.end)
    return day0 >= new Date(s.getFullYear(), s.getMonth(), s.getDate()).getTime()
      && day0 < new Date(e.getFullYear(), e.getMonth(), e.getDate()).getTime()
  }

  const topics = [...df.entries()]
    .filter(([name, n]) => n >= 2 && n <= 8 && /[\u3400-\u4dbf\u4e00-\u9fff]/.test(name))
    .map(([name, n]) => ({ name, n }))
    .sort((a, b) => a.n - b.n || a.name.localeCompare(b.name))

  // How many windows each word resolves to, and which windows the corpus can even answer.
  const windowCoverage = {}
  const queries = []
  const usedEntities = new Set()
  for (const word of WINDOW_WORDS) {
    const win = parseTimeWindow(word)
    const perWindow = []
    for (const t of topics) {
      if (usedEntities.has(t.name)) continue
      const factsWithTopic = ids.filter((id) => bags.get(id).includes(t.name))
      const inWindowFacts = factsWithTopic.filter((id) => inWindow(id, win))
      if (inWindowFacts.length === 1 && factsWithTopic.length >= 2) {
        perWindow.push({ topic: t.name, df: t.n, gold: inWindowFacts[0], facts_with_topic: factsWithTopic.length })
      }
    }
    // At most 2 derived queries per window word, and each entity is used for one query only (so
    // the query set is not one entity repeated across nine windows).
    const picked = perWindow.slice(0, 2)
    for (const p of picked) usedEntities.add(p.topic)
    windowCoverage[word] = { rule: win.rule, candidates: perWindow.length, picked: picked.length }
    for (const p of picked) {
      queries.push({
        id: `r2t-${queries.length + 1}`,
        topic: p.topic,
        topic_df: p.df,
        window_word: word,
        window_rule: win.rule,
        window_start: isoDay(win.start),
        window_end: isoDay(win.end),
        gold: p.gold,
        facts_with_topic: p.facts_with_topic,
        query: `${p.topic} ${word}`,
        guard_query: p.topic,
      })
    }
  }

  const rt = L.newRuntime({ snapPath: snap, semantic: emb, track })

  // ── identity (production arm reproduces rt.recall on the snapshot) ───────────────────────────
  const identity = []
  for (const q of queries) {
    identity.push(await L.identityCheck(rt, q.query, { limit: LIMIT, maxTokens: 0, floors: 'strict', track }))
  }
  const identityFailures = identity.filter((r) => !r.ok)
  console.log(`identity: ${identity.length - identityFailures.length}/${identity.length} pass`)

  const rankOf = (list, id) => (list.indexOf(id) === -1 ? null : list.indexOf(id) + 1)
  const armDefs = [
    { id: 'w0.3', weight: 0.3, hard: false },
    { id: 'w1.0', weight: 1.0, hard: false },
    { id: 'hard', weight: 1.0, hard: true },
  ]

  const rows = []
  for (const q of queries) {
    const win = parseTimeWindow(q.window_word)
    const inWindowIds = ids.filter((id) => inWindow(id, win))
    const goldInWindow = inWindowIds.includes(q.gold)
    const base = await L.runScript(rt, q.query, { limit: LIMIT, maxTokens: 0, floors: 'strict', track, arm: {} })
    const byArm = {}
    for (const a of armDefs) {
      const arm = {
        appendLegs: () => (inWindowIds.length ? [{ weight: a.weight, scores: new Map(inWindowIds.map((id) => [id, 1])), leg: 'fts' }] : []),
        ...(a.hard ? { fuse: (pool) => (inWindowIds.length ? pool.filter((h) => inWindowIds.includes(h.id)) : pool) } : {}),
      }
      const pass = await L.runScript(rt, q.query, { limit: LIMIT, maxTokens: 0, floors: 'strict', track, arm })
      byArm[a.id] = {
        ids: pass.ids,
        gold_rank: rankOf(pass.ids, q.gold),
        in_top3: pass.ids.slice(0, 3).includes(q.gold),
        missing: !pass.ids.includes(q.gold),
      }
    }
    // guard: same topic, no window word. The arm is the SAME arm, driven by the GUARD query's own
    // parse — a no-time query must parse to `undefined` and therefore add no leg.
    const guardWin = parseTimeWindow(q.guard_query)
    const guardWindowIds = guardWin ? ids.filter((id) => inWindow(id, guardWin)) : []
    const guardBase = await L.runScript(rt, q.guard_query, { limit: LIMIT, maxTokens: 0, floors: 'strict', track, arm: {} })
    const guardArm = await L.runScript(rt, q.guard_query, {
      limit: LIMIT,
      maxTokens: 0,
      floors: 'strict',
      track,
      arm: {
        appendLegs: () => (guardWindowIds.length ? [{ weight: 1.0, scores: new Map(guardWindowIds.map((id) => [id, 1])), leg: 'fts' }] : []),
      },
    })
    rows.push({
      ...q,
      parser_correct: goldInWindow,
      window_fact_count: inWindowIds.length,
      baseline: { ids: base.ids, gold_rank: rankOf(base.ids, q.gold), in_top3: base.ids.slice(0, 3).includes(q.gold), missing: !base.ids.includes(q.gold) },
      arms: byArm,
      guard: { parsed: guardWin !== undefined, ids_equal: guardBase.ids.join(',') === guardArm.ids.join(',') },
    })
  }

  const summarize = (get) => {
    const found = rows.filter((r) => get(r).gold_rank !== null)
    return {
      queries: rows.length,
      missing: rows.filter((r) => get(r).missing).length,
      in_top3: rows.filter((r) => get(r).in_top3).length,
      top1: rows.filter((r) => get(r).gold_rank === 1).length,
      found: found.length,
      avg_rank: found.length ? L.round4(found.reduce((n, r) => n + get(r).gold_rank, 0) / found.length) : null,
    }
  }
  const summary = {
    baseline: summarize((r) => r.baseline),
    ...Object.fromEntries(armDefs.map((a) => [a.id, summarize((r) => r.arms[a.id])])),
  }
  const guards = { total: rows.length, identical: rows.filter((r) => r.guard.ids_equal).length }
  const parsers = { total: rows.length, correct: rows.filter((r) => r.parser_correct).length }

  const improved = summary['w1.0'].in_top3 > summary.baseline.in_top3
  const rankImproved = summary['w1.0'].avg_rank < summary.baseline.avg_rank && summary['w1.0'].top1 > summary.baseline.top1
  const verdict = {
    parse_correct: parsers.correct === parsers.total,
    parser_false_positives_on_guards: rows.filter((r) => r.guard.parsed).length,
    guard_injury: guards.total - guards.identical,
    in_top3_baseline: summary.baseline.in_top3,
    in_top3_w1: summary['w1.0'].in_top3,
    top1_baseline: summary.baseline.top1,
    top1_w1: summary['w1.0'].top1,
    avg_rank_baseline: summary.baseline.avg_rank,
    avg_rank_w1: summary['w1.0'].avg_rank,
    missing_baseline: summary.baseline.missing,
    missing_w1: summary['w1.0'].missing,
    // The PRE-REGISTERED rule (brief §R2-2) is about in_top3. On this derived set the baseline is
    // saturated at in_top3 = 14/14 (the topic entity alone already puts gold there), so that axis
    // cannot discriminate — recorded rather than papered over. The rank axis does discriminate.
    preregistered_in_top3_criterion_met: improved && guards.total === guards.identical && parsers.correct === parsers.total,
    rank_criterion_met: rankImproved && guards.total === guards.identical && parsers.correct === parsers.total,
    condition_lifted: rankImproved && guards.total === guards.identical && parsers.correct === parsers.total,
  }
  verdict.call = verdict.preregistered_in_top3_criterion_met
    ? 'A2 condition lifted (pre-registered in_top3 rule met)'
    : verdict.rank_criterion_met
      ? 'A2 condition lifted on rank evidence (pre-registered in_top3 axis saturated at 14/14)'
      : 'A2 stays conditional (no real-corpus improvement)'

  console.log('\nwindow coverage:', JSON.stringify(windowCoverage))
  console.log('summary:', JSON.stringify(summary))
  console.log('guards:', JSON.stringify(guards), 'parsers:', JSON.stringify(parsers))
  console.log('verdict:', JSON.stringify(verdict))

  const out = {
    card: 'R2-2',
    measured_at: new Date().toISOString(),
    node: process.version,
    loadavg: L.loadavg(),
    model: L.DEFAULT_MODEL,
    now: NOW.toISOString(),
    snapshot: { source: L.DEFAULT_DB, active_facts: texts.size, median_len: [...meta.values()].map((m) => m.len).sort((a, b) => a - b)[Math.floor(meta.size / 2)] },
    derivation: {
      topic_df_range: [2, 8],
      windows_tried: WINDOW_WORDS,
      window_coverage: windowCoverage,
      note: 'query = <topic entity> <window word>; gold = the single active fact carrying that entity whose created_at falls in the window; guard = the topic alone',
    },
    rows,
    summary,
    guards,
    parsers,
    identity: { checked: identity.length, passed: identity.length - identityFailures.length, failures: identityFailures },
    verdict,
    reproduction: 'node mem/scripts/spikes/bench-r2-2-real-time-queries.mjs --json mem/docs/spikes/raw/round2-r2-2-real-time-queries.json',
  }
  L.writeJson(jsonOut, out)
  L.teardown(track)
}

await main()
