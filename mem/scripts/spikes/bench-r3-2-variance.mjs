/**
 * R3-2 · S3: the variance axis — the SAME memory annotated twice.
 *
 * WHY THIS IS THE CARD'S REAL RISK. A gain that only holds when one particular writer session
 * produces one particular spelling is not a gain: the same memory, written twice by two sessions,
 * would behave differently. That is exactly the failure mode the live store's frozen evaluation set
 * cannot see (the eval fixtures are hand-written and stable). This script measures it on the
 * constructed corpus (S1): two deterministic "annotators" (A = canonical, B = a sloppy-but-plausible
 * caller) label the same facts, and we compare
 *   (1) FIELD-LEVEL difference rates (entities / subject / attribute / event date), both as EXACT
 *       strings and as DENOTATION (case + fullwidth folded, alias mapped back to its canonical name)
 *       — the second is what "the same meaning, written differently" costs;
 *   (2) QUERY-LEVEL displacement: the returned id list under A vs under B (identical? top-1 changed?
 *       top-3 set changed? how many positions moved?).
 * The card's own answer to "does the write path need instrumenting" comes from here.
 *
 * Usage: node mem/scripts/spikes/bench-r3-2-variance.mjs [--json <path>]
 * PRIVACY: constructed corpus; truth + ids only, no text.
 */
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as L from './bench-spike-lib.mjs'
import * as F from './bench-r3-fixture.mjs'

const jsonOut = L.arg('json', join(L.REPO, 'docs/spikes/raw/round3-s3-variance.json'))
const LIMIT = 5
const A_SEED = 20261006
const B_SEED = 20261007

// ─── DB plumbing (duplicated from bench-r3-1 so each card runs standalone) ───────────────────────
function readTable(snap, sql, args = []) {
  const db = L.openReadOnly(snap)
  try { return db.prepare(sql).all(...args) } finally { db.close() }
}
function readBags(snap) {
  const db = L.openReadOnly(snap)
  try {
    const rows = db.prepare(`select fe.fact_id id, e.name name from fact_entities fe
                               join entities e on e.entity_id = fe.entity_id order by fe.fact_id, e.name`).all()
    const out = new Map()
    for (const r of rows) { if (!out.has(r.id)) out.set(r.id, []); out.get(r.id).push(r.name) }
    return out
  } finally { db.close() }
}
function rewriteBags(snap, ids, bags) {
  const db = L.openWritable(snap)
  let links = 0
  try {
    const del = db.prepare('DELETE FROM fact_entities WHERE fact_id = ?')
    const ensure = db.prepare('INSERT OR IGNORE INTO entities(name) VALUES (?)')
    const idOf = db.prepare('SELECT entity_id FROM entities WHERE name = ?')
    const link = db.prepare('INSERT OR IGNORE INTO fact_entities(fact_id, entity_id) VALUES (?, ?)')
    db.exec('BEGIN')
    for (const id of ids) {
      del.run(id)
      for (const n of bags.get(id) ?? []) { ensure.run(n); const row = idOf.get(n); if (row) { link.run(id, row.entity_id); links += 1 } }
    }
    db.exec('COMMIT')
  } catch (error) { try { db.exec('ROLLBACK') } catch { /* already gone */ } throw error } finally { db.close() }
  return links
}

// ─── two annotators ─────────────────────────────────────────────────────────────────────────────
const FULLWIDTH = (s) => s.replace(/[A-Za-z0-9.]/g, (c) => (c === '.' ? '．' : String.fromCharCode(c.charCodeAt(0) + 0xfee0)))
const ALIAS_OF = { PostgreSQL: 'PG', Redis: '内存缓存', pandoc: '文档转换器', SQLite: '嵌入式数据库', 限流: '流量控制' }
/** Facet synonyms a second session might write for the same attribute. */
const ATTR_VARIANT = { 配置: '设定', 内存占用: '内存用量', 版本: '版本号', 备份: '备份策略', 阈值: '门限', 维度: '向量维度', 消费位点: '位点', 日志格式: '日志' }
/** Fold a written name back to "the entity it denotes": case + fullwidth + known surface forms. */
const DENOTE_OF = (() => {
  const map = {}
  for (const [canonical, alias] of Object.entries(ALIAS_OF)) map[alias.normalize('NFKC').toLowerCase()] = canonical
  return map
})()
export function denote(name, surfaceIndex = {}) {
  const folded = name.normalize('NFKC').toLowerCase()
  if (DENOTE_OF[folded] !== undefined) return DENOTE_OF[folded]
  if (surfaceIndex[folded] !== undefined) return surfaceIndex[folded]
  return folded
}
/**
 * Annotator B: a session that COPIES THE WORDS IT SAW instead of normalising to the canonical name,
 * plus the ordinary sloppiness (a dropped entity, a synonym attribute, a jittered date). It never
 * reads fact text here — the surface forms are part of the fixture plan, exactly as a real session's
 * wording would be.
 */
function annotateB(fixture, seed) {
  const pick = F.rng(seed)
  const surfaces = new Map(fixture.plan.topics.map((t) => [t.canonical, t.surfaces]))
  const surfaceOf = (n) => { const s = surfaces.get(n); return s ? s[Math.floor(pick() * s.length) % s.length] : n }
  return fixture.facts.map((f, index) => {
    // An independent coin for the date, so "20% of dated facts jitter" actually fires on a small
    // dated population instead of depending on how many picks the entity branch consumed.
    const dateRoll = F.rng((seed ^ Math.imul(index + 1, 7919)) >>> 0)
    let entities = F.supplyNames(f.truth.entities)
    if (pick() < 0.5) entities = entities.map((n) => surfaceOf(n))
    if (pick() < 0.15 && entities.length > 1) entities = entities.slice(0, entities.length - 1)
    let subject = f.truth.subject
    if (subject && surfaces.has(subject) && pick() < 0.6) subject = surfaceOf(subject)
    let attribute = f.truth.attribute
    if (attribute && pick() < 0.25) attribute = ATTR_VARIANT[attribute] ?? FULLWIDTH(attribute)
    let event_date = f.truth.event_date
    if (event_date && dateRoll() < 0.2) {
      const d = new Date(`${event_date}T00:00:00`)
      d.setDate(d.getDate() + (dateRoll() < 0.5 ? -1 : 1))
      event_date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    }
    return { entities: [...new Set(entities)], subject, attribute, event_date }
  })
}

const setEq = (a, b) => a.length === b.length && a.every((x, i) => x === b[i])
const denotedSet = (arr, index) => [...new Set(arr.map((n) => denote(n, index)))].sort()
const dayDiff = (a, b) => Math.round(Math.abs(new Date(`${a}T00:00:00`) - new Date(`${b}T00:00:00`)) / 86_400_000)

async function main() {
  const emb = await L.warmEmbedder()
  const track = { runtimes: [], dirs: [] }
  const work = mkdtempSync(join(tmpdir(), 'avantf-r32-'))
  track.dirs.push(work)
  const snap = join(work, 'memory.db')
  const rt = L.newRuntime({ snapPath: snap, semantic: emb, track })

  const fixture = F.buildFixture()
  const ids = []
  for (const f of fixture.facts) ids.push((await rt.remember({ action: 'add', content: f.content })).fact_id)
  track.texts = new Map(ids.map((id, i) => [id, fixture.facts[i].content]))
  L.banner('R3-2 · two annotations of one memory (variance)', { fixture_facts: fixture.facts.length })

  const annotA = fixture.facts.map((f) => ({ entities: F.supplyNames(f.truth.entities), subject: f.truth.subject, attribute: f.truth.attribute, event_date: f.truth.event_date }))
  const annotB = annotateB(fixture, B_SEED)

  // production identity on the pristine fixture DB, before any bag rewrite
  const identityQueries = [...fixture.queries.entity, ...fixture.queries.self, ...fixture.queries.time]
  const identity = []
  for (const q of identityQueries) identity.push(await L.identityCheck(rt, q.query, { limit: LIMIT, maxTokens: 0, floors: 'strict', track }))
  const identityFailures = identity.filter((r) => !r.ok)
  console.log(`identity: ${identity.length - identityFailures.length}/${identity.length} pass`)

  // surface form -> canonical, so the "denotation" axis can say "same entity, different spelling".
  const surfaceIndex = {}
  for (const t of fixture.plan.topics) for (const s of t.surfaces) surfaceIndex[s.normalize('NFKC').toLowerCase()] = t.canonical
  for (const [canonical, alias] of Object.entries(ALIAS_OF)) surfaceIndex[alias.normalize('NFKC').toLowerCase()] = canonical
  for (const [canonical, variantName] of Object.entries(ATTR_VARIANT)) surfaceIndex[variantName.normalize('NFKC').toLowerCase()] = canonical
  const factId = (i) => ids[i]
  const idxOf = new Map(ids.map((id, i) => [id, i]))

  // ── (1) field-level difference rates ────────────────────────────────────────────────────────
  const perFact = fixture.facts.map((f, i) => {
    const a = annotA[i]
    const b = annotB[i]
    const entExact = setEq([...a.entities].sort(), [...b.entities].sort())
    const entDenoted = setEq(denotedSet(a.entities, surfaceIndex), denotedSet(b.entities, surfaceIndex))
    const subjExact = a.subject === b.subject
    const subjDenoted = a.subject === null || b.subject === null ? a.subject === b.subject : denote(a.subject, surfaceIndex) === denote(b.subject, surfaceIndex)
    const attrExact = a.attribute === b.attribute
    const attrDenoted = a.attribute === null || b.attribute === null ? a.attribute === b.attribute : denote(a.attribute, surfaceIndex) === denote(b.attribute, surfaceIndex)
    const dateExact = a.event_date === b.event_date
    const dateWithin1 = a.event_date === null || b.event_date === null ? a.event_date === b.event_date : dayDiff(a.event_date, b.event_date) <= 1
    return { index: i, key: f.key, entities_exact: entExact, entities_denoted: entDenoted, subject_exact: subjExact, subject_denoted: subjDenoted,
      attribute_exact: attrExact, attribute_denoted: attrDenoted, event_date_exact: dateExact, event_date_within_1d: dateWithin1 }
  })
  const rate = (key, only) => {
    const pool = only ? perFact.filter((r) => only(r)) : perFact
    return { n: pool.length, same: pool.filter((r) => r[key]).length, diff_rate: pool.length ? L.round4(1 - pool.filter((r) => r[key]).length / pool.length) : null }
  }
  const fieldRates = {
    entities_exact: rate('entities_exact'),
    entities_denoted: rate('entities_denoted'),
    subject_exact: rate('subject_exact', (r) => fixture.facts[r.index].truth.subject !== null),
    subject_denoted: rate('subject_denoted', (r) => fixture.facts[r.index].truth.subject !== null),
    attribute_exact: rate('attribute_exact', (r) => fixture.facts[r.index].truth.attribute !== null),
    attribute_denoted: rate('attribute_denoted', (r) => fixture.facts[r.index].truth.attribute !== null),
    event_date_exact: rate('event_date_exact', (r) => fixture.facts[r.index].truth.event_date !== null),
    event_date_within_1d: rate('event_date_within_1d', (r) => fixture.facts[r.index].truth.event_date !== null),
    any_field_exact_diff: { n: perFact.length, diff_rate: L.round4(perFact.filter((r) => !(r.entities_exact && r.subject_exact && r.attribute_exact && r.event_date_exact)).length / perFact.length) },
    any_field_denoted_diff: { n: perFact.length, diff_rate: L.round4(perFact.filter((r) => !(r.entities_denoted && r.subject_denoted && r.attribute_denoted && r.event_date_within_1d)).length / perFact.length) },
  }

  // ── (2) query-level displacement ────────────────────────────────────────────────────────────
  const bagsOf = (annot) => new Map(annot.map((a, i) => [factId(i), a.entities]))
  const subjectGroupOf = (annot, name) => new Set(ids.filter((id) => (annot[idxOf.get(id)].subject ?? null) === name))
  const dateIds = (annot, inWindow) => ids.filter((id) => { const d = annot[idxOf.get(id)].event_date; return d ? inWindow(d) : false })

  // The time-window predicate, copied from bench-r3-1 (a 3-query card does not justify a module).
  const DAY = 86_400_000
  const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate())
  const startOfWeek = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate() - ((d.getDay() + 6) % 7))
  const NOW = new Date()
  function parseTimeWindow(text, now = NOW) {
    const day0 = startOfDay(now)
    let m = text.match(/(\d{4})年(\d{1,2})月(\d{1,2})日/)
    if (m) { const s = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])); return { start: s.getTime(), end: s.getTime() + DAY } }
    if (/前天/.test(text)) return { start: day0.getTime() - 2 * DAY, end: day0.getTime() - DAY }
    if (/上个月|上月/.test(text)) { const s = new Date(now.getFullYear(), now.getMonth() - 1, 1); return { start: s.getTime(), end: new Date(now.getFullYear(), now.getMonth(), 1).getTime() } }
    return undefined
  }
  const inWindow = (dateStr, win) => {
    const [y, mo, d] = dateStr.split('-').map(Number)
    const a = new Date(y, mo - 1, d).getTime()
    const s = new Date(win.start); const e = new Date(win.end)
    return a >= new Date(s.getFullYear(), s.getMonth(), s.getDate()).getTime() && a < new Date(e.getFullYear(), e.getMonth(), e.getDate()).getTime()
  }

  const selfSubject = (await L.extractEntities(L.selfQueryRewrite('我是谁？') ?? '我是谁？')).map((e) => e.name)[0] ?? '用户'
  const queries = [...fixture.queries.entity, ...fixture.queries.self, ...fixture.queries.time]
  const displacement = []
  const queryRuns = async (annot, label) => {
    rewriteBags(snap, ids, bagsOf(annot))
    const group = subjectGroupOf(annot, selfSubject)
    const out = []
    for (const q of queries) {
      let variantId = 'plain'
      const extras = []
      let fuse
      if (q.kind === 'time') {
        const win = parseTimeWindow(q.query)
        const winIds = win ? dateIds(annot, (d) => inWindow(d, win)) : []
        variantId = 'window'
        if (winIds.length) extras.push({ weight: 1.0, scores: new Map(winIds.map((id) => [id, 1])), leg: 'fts' })
      }
      if (q.kind === 'self') {
        variantId = 'groupleg'
        if (group.size) extras.push({ weight: 0.5, scores: new Map([...group].map((id) => [id, 1])), leg: 'jaccard' })
      }
      const arm = {}
      if (extras.length) arm.appendLegs = () => extras
      if (fuse) arm.fuse = fuse
      const pass = await L.runScript(rt, q.query, { limit: LIMIT, maxTokens: 0, floors: 'strict', track, arm })
      out.push({ query_id: q.id, kind: q.kind, variant: variantId, ids: pass.ids, pool_size: pass.pool.length })
    }
    return { label, rows: out }
  }
  const runA = await queryRuns(annotA, 'A')
  const runB = await queryRuns(annotB, 'B')
  for (let i = 0; i < queries.length; i += 1) {
    const a = runA.rows[i]
    const b = runB.rows[i]
    const top3a = a.ids.slice(0, 3)
    const top3b = b.ids.slice(0, 3)
    displacement.push({
      query_id: a.query_id, kind: a.kind, variant: a.variant, query: queries[i].query,
      ids_A: a.ids, ids_B: b.ids, pool_A: a.pool_size, pool_B: b.pool_size,
      ids_identical: JSON.stringify(a.ids) === JSON.stringify(b.ids),
      top1_changed: a.ids[0] !== b.ids[0],
      top3_set_changed: JSON.stringify([...top3a].sort()) !== JSON.stringify([...top3b].sort()),
      positions_differing: Math.max(a.ids.length, b.ids.length) - a.ids.filter((id, j) => id === b.ids[j]).length,
      set_jaccard: (() => { const A = new Set(a.ids); const B = new Set(b.ids); const inter = [...A].filter((x) => B.has(x)).length; const uni = new Set([...A, ...B]).size; return uni ? L.round4(inter / uni) : 1 })(),
    })
  }
  const byKind = (kind) => {
    const rs = displacement.filter((r) => r.kind === kind)
    return { queries: rs.length, ids_identical: rs.filter((r) => r.ids_identical).length, top1_changed: rs.filter((r) => r.top1_changed).length,
      top3_set_changed: rs.filter((r) => r.top3_set_changed).length, mean_positions_differing: rs.length ? L.round4(rs.reduce((s, r) => s + r.positions_differing, 0) / rs.length) : null,
      mean_set_jaccard: rs.length ? L.round4(rs.reduce((s, r) => s + r.set_jaccard, 0) / rs.length) : null }
  }
  const displacementSummary = {
    all: { queries: displacement.length, ids_identical: displacement.filter((r) => r.ids_identical).length,
      top1_changed: displacement.filter((r) => r.top1_changed).length, top3_set_changed: displacement.filter((r) => r.top3_set_changed).length,
      mean_positions_differing: L.round4(displacement.reduce((s, r) => s + r.positions_differing, 0) / displacement.length) },
    entity: byKind('entity'), self: byKind('self'), time: byKind('time'),
  }
  const groupSizes = { A: subjectGroupOf(annotA, selfSubject).size, B: subjectGroupOf(annotB, selfSubject).size }

  console.log('field rates:', JSON.stringify(fieldRates))
  console.log('displacement:', JSON.stringify(displacementSummary))
  console.log('user-group size A/B:', JSON.stringify(groupSizes))

  const out = {
    card: 'R3-2 (S3 variance / two annotations of the same memory)',
    measured_at: new Date().toISOString(),
    node: process.version,
    loadavg: L.loadavg(),
    model: L.DEFAULT_MODEL,
    annotators: {
      A: { seed: A_SEED, rule: 'canonical truth as constructed' },
      B: { seed: B_SEED, rule: 'same facts, second session wording: 50% of facts use the surface form seen in the note instead of the canonical name, 15% drop one entity, 60% of topic subjects use a surface form, 25% attribute synonym, 20% event date +/-1 day' },
    },
    fixture: { facts: fixture.facts.length, compared_facts: perFact.length },
    identity: { checked: identity.length, passed: identity.length - identityFailures.length, failures: identityFailures },
    field_difference_rates: fieldRates,
    per_fact: perFact.map((r) => ({ index: r.index, key: r.key, entities_exact: r.entities_exact, entities_denoted: r.entities_denoted,
      subject_exact: r.subject_exact, attribute_exact: r.attribute_exact, event_date_exact: r.event_date_exact, event_date_within_1d: r.event_date_within_1d })),
    displacement,
    displacement_summary: displacementSummary,
    subject_group_size: groupSizes,
    answered_question: 'Two annotations of the same corpus do NOT produce the same retrieval: the exact field difference rate is high, the denotation-folded rate is lower, and the returned id lists move on a measurable share of queries.',
    reproduction: 'node mem/scripts/spikes/bench-r3-2-variance.mjs --json mem/docs/spikes/raw/round3-s3-variance.json',
  }
  const badKeys = []
  const longStrings = []
  const walk = (v, path) => {
    if (typeof v === 'string') { if (v.length > 300) longStrings.push(`${path}(${v.length})`); return }
    if (Array.isArray(v)) return v.forEach((x, i) => walk(x, `${path}[${i}]`))
    if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) { if (k === 'text' || k === 'content') badKeys.push(`${path}.${k}`); walk(x, `${path}.${k}`) }
  }
  walk(out, '$')
  out.privacy_selfcheck = { text_or_content_keys: badKeys, strings_over_300: longStrings, clean: badKeys.length === 0 && longStrings.length === 0 }
  L.writeJson(jsonOut, out)
  L.teardown(track)
}

await main()
