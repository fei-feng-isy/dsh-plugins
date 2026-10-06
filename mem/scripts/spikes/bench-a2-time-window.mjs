/**
 * P1-2 · A2 — Chinese TIME WINDOWS on the query side (a query-class capability).
 *
 * TODAY the query side ignores time entirely: `<topic> 上个月` and `<topic> 今天` retrieve the same
 * thing. This card tests a script-side parser + a window leg, and — because the design risk is a
 * MIS-PARSE (the hindsight/dateparser lesson) — it makes a NO-TIME GUARD set a hard gate: a query
 * with no time expression must return byte-identical ids with and without the arm.
 *
 * HONESTY ABOUT GOLD (measure first, then decide). The real library has no labelled time-window
 * gold, so the first thing the script does is run the parser over all 61 real/frozen queries and
 * report how many carry a time expression (measured: 0). The capability is therefore measured on a
 * SCRIPT-SIDE FIXTURE whose facts carry KNOWN dates and whose LENGTH DISTRIBUTION copies the real
 * corpus (median ~313 chars, a 9-char fact, an 800+ char note), plus a literal-collision distractor
 * and a counterfactual assertion (remove the distractor -> the gold rank returns).
 *
 * ARMS
 *   A production (no time handling), identity-checked.
 *   B the window leg: facts whose `created_at` falls in the parsed window get a bounded boost,
 *     added as an extra leg with the FTS weight (0.30). Everything else is production.
 *
 * VERDICT RULE (brief): window-gold rank improves AND guard false-injury = 0 ⇒ adopt; else reject.
 *
 * Usage: node mem/scripts/spikes/bench-a2-time-window.mjs
 * PRIVACY: no live fact text is printed; the fixture text is authored by this script.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import * as L from './bench-spike-lib.mjs'

const require = createRequire(import.meta.url)
const jsonOut = L.arg('json', join(L.REPO, 'docs/spikes/raw/a2-time-window.json'))
const LIMIT = 5
const NOW = new Date('2026-10-05T12:00:00+08:00')

// ─── the parser (script-side; NOT production) ─────────────────────────────────
const DAY = 86_400_000
const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate())
/** ISO week: Monday = start. */
const startOfWeek = (d) => {
  const day = (d.getDay() + 6) % 7
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() - day)
}

/** Parse one Chinese time expression. Returns {start,end,rule} or undefined. */
export function parseTimeWindow(text, now = NOW) {
  const q = text
  const day0 = startOfDay(now)
  // absolute first: a full date must win over the "m月" month rule.
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

// ─── the fixture (authored here; real-shaped) ─────────────────────────────────
const FILLER = (n) => '。补充说明：这条记录用于复刻真实语料的长度形状，不承载任何真实数据'.repeat(Math.ceil(n / 30)).slice(0, n)
const WINDOWS = {
  今天: new Date('2026-10-05T09:00:00+08:00'),
  昨天: new Date('2026-10-04T09:00:00+08:00'),
  前天: new Date('2026-10-03T09:00:00+08:00'),
  上个月: new Date('2026-09-15T09:00:00+08:00'),
  '2026年8月15日': new Date('2026-08-15T09:00:00+08:00'),
}
// The five windows are PAIRWISE DISJOINT on purpose: with overlapping windows (e.g. 上周 and
// 上个月 both containing 2026-09-30) a single "gold" fact is ambiguous and the arm is rewarded or
// punished for a fixture artefact rather than for the capability.
const TOPICS = ['缓存', '部署', '限流']
const TOPIC_BODY = {
  缓存: (n) => `缓存键的过期策略相关决定，第 ${n} 次记录`,
  部署: (n) => `生产环境的部署流程相关决定，第 ${n} 次记录`,
  限流: (n) => `接口限流的阈值相关决定，第 ${n} 次记录`,
}

function buildFixture() {
  const facts = []
  let n = 0
  for (const topic of TOPICS) {
    for (const [w, date] of Object.entries(WINDOWS)) {
      n += 1
      // Real-shaped: a short one, a median one, a long one across the grid. The body does NOT
      // mention the window word — the facts are distinguishable only by DATE, which is the whole
      // point of the capability (otherwise the FTS leg would solve it lexically).
      const len = n % 5 === 0 ? 12 : n % 5 === 1 ? 300 : 830
      const body = TOPIC_BODY[topic](n)
      facts.push({ content: len <= 12 ? body : `${body}。${FILLER(len - body.length)}`, date, topic, window: w })
    }
  }
  // literal-collision distractor: an unrelated LONG note that contains the time expression verbatim
  facts.push({ content: `无关长笔记：${FILLER(800)}上个月上个月上个月`, date: new Date('2026-09-20T09:00:00+08:00'), topic: null, window: null, distractor: true })
  return facts
}

async function main() {
  // ── honesty check: does the real library have ANY time-scoped query? ─────────
  const realTexts = [...L.REAL_QUERIES.map((q) => q.q), ...L.frozenCases().flatMap((c) => c.queries.map((q) => q.query))]
  const parsedReal = realTexts.map((q) => ({ query: q, parsed: parseTimeWindow(q) ?? null })).filter((x) => x.parsed !== null)
  console.log(`real+frozen queries scanned: ${realTexts.length}, carrying a time expression: ${parsedReal.length}`)

  const emb = await L.warmEmbedder()
  const track = { runtimes: [], dirs: [] }
  const work = mkdtempSync(join(tmpdir(), 'avantf-a2-'))
  track.dirs.push(work)
  const snap = join(work, 'memory.db')
  const rt = L.newRuntime({ snapPath: snap, semantic: emb, track })

  const fixture = buildFixture()
  const ids = []
  for (const f of fixture) ids.push((await rt.remember({ action: 'add', content: f.content })).fact_id)
  // rewrite the dates on the TEMP copy only (never the live store).
  {
    const { DatabaseSync } = require('node:sqlite')
    const db = new DatabaseSync(snap)
    try {
      for (let i = 0; i < fixture.length; i += 1) {
        const iso = fixture[i].date.toISOString().replace('T', ' ').slice(0, 19)
        db.prepare('update facts set created_at = ?, updated_at = ? where fact_id = ?').run(iso, iso, ids[i])
      }
    } finally {
      db.close()
    }
  }
  const texts = new Map()
  for (let i = 0; i < fixture.length; i += 1) texts.set(ids[i], fixture[i].content)
  track.texts = texts
  const distractorId = ids[fixture.findIndex((f) => f.distractor)]

  L.banner('A2 · time window', { fixture_facts: fixture.length, real_time_queries: parsedReal.length })

  // ── the 15 time queries + 5 no-time guards ──────────────────────────────────
  const timeQueries = []
  for (const topic of TOPICS) {
    for (const w of Object.keys(WINDOWS)) {
      const factIdx = fixture.findIndex((f) => f.topic === topic && f.window === w)
      timeQueries.push({ query: `${topic} ${w}`, topic, window: w, gold: [ids[factIdx]] })
    }
  }
  const guards = ['缓存', '部署', '限流', '缓存怎么配置', '部署流程'].map((q) => ({ query: q }))

  const windowIds = (parsed) => {
    // A real indexed SQL window over `facts.created_at` (idx_facts_created), not an in-memory map.
    const db = L.openReadOnly(snap)
    try {
      const s = new Date(parsed.start).toISOString().slice(0, 19).replace('T', ' ')
      const e = new Date(parsed.end).toISOString().slice(0, 19).replace('T', ' ')
      const rows = db
        .prepare("select fact_id id from facts where status = 'active' and created_at >= ? and created_at < ?")
        .all(s, e)
      return new Set(rows.map((r) => r.id))
    } finally {
      db.close()
    }
  }

  const windowLegArm = (parsed, weight) => ({
    name: `window_w${weight}`,
    appendLegs: () => [{ weight, scores: new Map([...windowIds(parsed)].map((id) => [id, 1])), leg: 'fts' }],
  })

  /**
   * The natural production form of a time expression: the window SUPPLIES the candidates and then
   * restricts the pool to them. A pool filter alone cannot work — it can only remove, and the
   * production legs never admitted the in-window fact for these queries (measured), so the window
   * leg has to add it first. Falls back to the unfiltered pool when the window has no candidates.
   */
  const windowHardArm = (parsed) => ({
    name: 'window_hard',
    appendLegs: () => [{ weight: 1, scores: new Map([...windowIds(parsed)].map((id) => [id, 1])), leg: 'fts' }],
    fuse: (pool) => {
      const ids = windowIds(parsed)
      if (ids.size === 0) return pool
      const kept = pool.filter((h) => ids.has(h.id))
      return kept.length > 0 ? kept : pool
    },
  })

  const runOne = async (entry, arm) => {
    const pass = await L.runScript(rt, entry.query, { limit: LIMIT, maxTokens: 0, floors: 'strict', track, arm })
    const gold = entry.gold ?? []
    return { ids: pass.ids, gold_rank: gold.length ? (pass.ids.findIndex((id) => gold.includes(id)) === -1 ? null : pass.ids.findIndex((id) => gold.includes(id)) + 1) : null, top3: gold ? pass.ids.slice(0, 3).filter((id) => gold.includes(id)).length : null }
  }

  const identity = []
  for (const e of [...timeQueries, ...guards]) identity.push(await L.identityCheck(rt, e.query, { limit: LIMIT, maxTokens: 0, floors: 'strict', track }))
  const idFail = identity.filter((r) => !r.ok)
  console.log(`identity: ${identity.length - idFail.length}/${identity.length} pass`)

  const buildRows = async (armFactory, label) => {
    const timeRows = []
    const audit = []
    for (const e of timeQueries) {
      const parsed = parseTimeWindow(e.query)
      const intended = WINDOWS[e.window]
      const matchesIntended = parsed !== undefined && intended.getTime() >= parsed.start && intended.getTime() < parsed.end
      audit.push({ query: e.query, expected_window: e.window, expected_time: intended.toISOString(), parsed: parsed ? { rule: parsed.rule, matched: parsed.matched, start: new Date(parsed.start).toISOString(), end: new Date(parsed.end).toISOString() } : null, parse_ok: matchesIntended })
      const base = await runOne(e, {})
      const arm = parsed ? await runOne(e, armFactory(parsed)) : base
      timeRows.push({ ...e, parsed_rule: parsed?.rule ?? null, parse_ok: matchesIntended, base, arm })
    }
    const guardRows = []
    for (const e of guards) {
      const parsed = parseTimeWindow(e.query)
      const base = await runOne(e, {})
      const arm = parsed ? await runOne(e, armFactory(parsed)) : base
      guardRows.push({ query: e.query, parsed: parsed?.rule ?? null, base_ids: base.ids, arm_ids: arm.ids, identical: base.ids.join(',') === arm.ids.join(',') })
    }
    const rankStats = (key) => {
      const ranks = timeRows.map((r) => r[key].gold_rank)
      return {
        top1_gold: ranks.filter((r) => r === 1).length,
        in_top3: ranks.filter((r) => r !== null && r <= 3).length,
        missing: ranks.filter((r) => r === null).length,
        mean_rank: L.round4(ranks.filter((r) => r !== null).reduce((a, b) => a + b, 0) / Math.max(1, ranks.filter((r) => r !== null).length)),
      }
    }
    return { label, timeRows, audit, guardRows, summary: { base: rankStats('base'), arm: rankStats('arm'), guard_false_injury: guardRows.filter((g) => !g.identical).length, parse_ok: audit.filter((a) => a.parse_ok).length, parse_total: audit.length } }
  }

  const perWeight = {}
  const verdicts = {}
  const plans = [
    ['w0.3', (p) => windowLegArm(p, 0.3)],
    ['w1.0', (p) => windowLegArm(p, 1.0)],
    ['hard', (p) => windowHardArm(p)],
  ]
  for (const [label, factory] of plans) {
    const r = await buildRows(factory, label)
    perWeight[label] = r
    const improved = r.summary.arm.top1_gold > r.summary.base.top1_gold || r.summary.arm.in_top3 > r.summary.base.in_top3 || r.summary.arm.mean_rank < r.summary.base.mean_rank
    verdicts[label] = {
      improved,
      base: r.summary.base,
      arm: r.summary.arm,
      guard_false_injury: r.summary.guard_false_injury,
      parse_ok: `${r.summary.parse_ok}/${r.summary.parse_total}`,
      verdict: improved && r.summary.guard_false_injury === 0 ? 'adopt' : 'reject',
      caveat: parsedReal.length === 0 ? 'the real library carries NO time-scoped query, so this is measured on a script-authored real-shaped fixture, not on real user data' : null,
    }
  }
  // The counterfactual and the final JSON use the HARD-CONSTRAINT form.
  const chosen = perWeight.hard
  const { timeRows, audit, guardRows, summary } = chosen
  const verdict = verdicts.hard

  // ── counterfactual: remove the literal-collision distractor ─────────────────
  const counterfactual = []
  for (const e of timeQueries.filter((x) => x.query.includes('上个月'))) {
    const parsed = parseTimeWindow(e.query)
    const hard = windowHardArm(parsed)
    const withoutDistractor = {
      name: 'cf',
      appendLegs: hard.appendLegs,
      fuse: (pool) => (hard.fuse(pool) ?? pool).filter((h) => h.id !== distractorId),
    }
    const pass = await runOne(e, withoutDistractor)
    counterfactual.push({ query: e.query, distractor_id: distractorId, gold_rank_with_distractor: timeRows.find((r) => r.query === e.query)?.arm.gold_rank ?? null, gold_rank_without_distractor: pass.gold_rank })
  }

  console.log('summary', JSON.stringify(chosen.summary, null, 2))
  console.log('parse audit', JSON.stringify(audit, null, 2))
  console.log('guards', JSON.stringify(guardRows, null, 2))
  console.log('counterfactual', JSON.stringify(counterfactual, null, 2))
  console.log('verdicts', JSON.stringify(verdicts, null, 2))

  L.writeJson(jsonOut, {
    card: 'A2',
    measured_at: new Date().toISOString(),
    node: process.version,
    model: L.DEFAULT_MODEL,
    now: NOW.toISOString(),
    real_time_query_scan: { scanned: realTexts.length, carrying_time_expression: parsedReal.length, detail: parsedReal },
    fixture: { facts: fixture.length, windows: Object.fromEntries(Object.entries(WINDOWS).map(([k, v]) => [k, v.toISOString()])), topics: TOPICS, distractor_id: distractorId, note: 'script-authored, real-shaped lengths; dates written to the TEMP copy only' },
    parser_rules: ['yyyy年m月d日', 'yyyy-m-d', 'yyyy年m月', 'm月d日', '最近N天', '最近一周', '最近一个月', '今天/昨天/前天', '本周/上周', '这个月/上个月', '今年/去年'],
    arm: 'three forms: boost legs at weight 0.30 and 1.00, and a hard form (window leg supplies candidates + pool restricted to the window)',
    identity: { checked: identity.length, passed: identity.length - idFail.length, failures: idFail },
    summary,
    verdicts,
    selected_weight: 1.0,
    time_queries: timeRows,
    parse_audit: audit,
    guards: guardRows,
    counterfactual,
    verdict,
    per_weight_summary: Object.fromEntries(Object.entries(perWeight).map(([w, r]) => [w, { base: r.summary.base, arm: r.summary.arm, guard_false_injury: r.summary.guard_false_injury }])),
    reproduction: 'node mem/scripts/spikes/bench-a2-time-window.mjs',
  })
  L.teardown(track)
}

await main()
