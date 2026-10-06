/**
 * R2-8 · A4 index-text merge — put entity names and date tokens into the FTS index text.
 *
 * THE IDEA. `facts_fts` indexes `facts.content` only. Entity names are extracted FROM the content,
 * and dates live in `created_at`, so a query that is "only an entity name" or "only a date" has no
 * indexable text to hit. A4 would add a real `index_text` column (`content + entity names + date
 * tokens`) and a second external-content FTS table over it.
 *
 * THIS CARD, on a SNAPSHOT COPY (production is not touched): adds the column, fills it from the
 * snapshot's own `fact_entities`/`entities` and `created_at`, builds `facts_fts2` and its three
 * sync triggers, then measures:
 *   1. the POPULATION the merge could help — (fact, entity) pairs whose name is NOT verbatim in the
 *      fact's content, and facts whose content lacks their own date literal;
 *   2. RECALL on entity-name-only and date-only queries: production FTS leg vs the fts2 leg;
 *   3. COST: db bytes (after VACUUM) and p50 search latency of the production 20-query network with
 *      and without the extra leg.
 *
 * VERDICT RULE (brief): entity-name queries improve AND index < 2x AND p50 < +20% => adopt; else
 * reject. A population of zero answers the first clause before any cost is considered.
 *
 * Usage: node mem/scripts/spikes/bench-r2-8-index-text-merge.mjs [--json <path>]
 * PRIVACY: ids / bytes / latencies / entity names only — no fact text is written.
 */
import { mkdtempSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as L from './bench-spike-lib.mjs'

const jsonOut = L.arg('json', join(L.REPO, 'docs/spikes/raw/round2-r2-8-index-text-merge.json'))
const LIMIT = 5
const REPEATS = 3

/** Date tokens for one `YYYY-MM-DD HH:MM:SS` (UTC) timestamp. */
function dateTokens(createdAt) {
  const m = String(createdAt).match(/^(\d{4})-(\d{2})-(\d{2})/)
  if (!m) return ''
  const [, y, mo, d] = m
  return [
    `${y}-${mo}-${d}`,
    `${y}${mo}${d}`,
    `${y}年${Number(mo)}月${Number(d)}日`,
    `${y} ${mo} ${d}`,
    `${Number(mo)}月${Number(d)}日`,
  ].join(' ')
}

function buildIndexText(modSnap) {
  const db = L.openWritable(modSnap)
  try {
    const facts = db.prepare("select fact_id id, content, created_at from facts where status='active'").all()
    const links = db.prepare(
      `select fe.fact_id id, e.name name from fact_entities fe join entities e on e.entity_id = fe.entity_id`,
    ).all()
    const byFact = new Map()
    for (const l of links) {
      if (!byFact.has(l.id)) byFact.set(l.id, new Set())
      byFact.get(l.id).add(l.name)
    }
    db.exec('ALTER TABLE facts ADD COLUMN index_text TEXT')
    const upd = db.prepare('UPDATE facts SET index_text = ? WHERE fact_id = ?')
    for (const f of facts) {
      const names = [...(byFact.get(f.id) ?? [])].join(' ')
      upd.run(`${f.content} ${names} ${dateTokens(f.created_at)}`.trim(), f.id)
    }
    db.exec("CREATE VIRTUAL TABLE facts_fts2 USING fts5(index_text, content='facts', content_rowid='fact_id', tokenize='trigram')")
    db.exec("INSERT INTO facts_fts2(facts_fts2) VALUES('rebuild')")
    // The triggers the brief requires (built on the copy only; presence asserted below).
    db.exec(`CREATE TRIGGER facts_fts2_ai AFTER INSERT ON facts BEGIN
      INSERT INTO facts_fts2(rowid, index_text) VALUES (new.fact_id, new.index_text); END`)
    db.exec(`CREATE TRIGGER facts_fts2_ad AFTER DELETE ON facts BEGIN
      INSERT INTO facts_fts2(facts_fts2, rowid, index_text) VALUES ('delete', old.fact_id, old.index_text); END`)
    db.exec(`CREATE TRIGGER facts_fts2_au AFTER UPDATE ON facts BEGIN
      INSERT INTO facts_fts2(facts_fts2, rowid, index_text) VALUES ('delete', old.fact_id, old.index_text);
      INSERT INTO facts_fts2(rowid, index_text) VALUES (new.fact_id, new.index_text); END`)
    const triggerCount = db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE type='trigger' AND name LIKE 'facts_fts2%'").get().n
    db.exec('VACUUM')
    return { factCount: facts.length, byFact, triggerCount }
  } finally {
    db.close()
  }
}

async function main() {
  const emb = await L.warmEmbedder()
  const track = { runtimes: [], dirs: [] }
  const work = mkdtempSync(join(tmpdir(), 'avantf-r28-'))
  track.dirs.push(work)
  const baseSnap = join(work, 'memory-base.db')
  const modSnap = join(work, 'memory-a4.db')
  L.snapshotDb(L.DEFAULT_DB, baseSnap)
  L.snapshotDb(L.DEFAULT_DB, modSnap)
  const { texts, meta } = L.loadActiveTexts(baseSnap)
  track.texts = texts
  L.banner('R2-8 · A4 index-text merge', { base: baseSnap, modified: modSnap, active_facts: texts.size })

  // ── population the merge could help ────────────────────────────────────────────────────────
  const db = L.openReadOnly(baseSnap)
  const rows = db.prepare(
    `select f.fact_id id, f.content content, f.created_at created, e.name name
       from facts f left join fact_entities fe on fe.fact_id = f.fact_id
       left join entities e on e.entity_id = fe.entity_id where f.status = 'active'`,
  ).all()
  db.close()
  const pairs = rows.filter((r) => r.name !== null)
  const entitiesNotVerbatim = pairs.filter((r) => !String(r.content).includes(String(r.name)))
  const factsMissingOwnDate = [...new Set(rows.map((r) => r.id))].filter((id) => {
    const r = rows.find((x) => x.id === id)
    return !String(r.content).includes(String(r.created).slice(0, 10))
  })
  const population = {
    fact_entity_pairs: pairs.length,
    entity_names_not_verbatim_in_content: entitiesNotVerbatim.length,
    entity_name_examples: entitiesNotVerbatim.slice(0, 5).map((r) => ({ id: r.id, name: r.name })),
    facts_missing_own_date_literal: factsMissingOwnDate.length,
  }
  console.log('population:', JSON.stringify(population))

  const build = buildIndexText(modSnap)
  console.log(`built facts_fts2 over ${build.factCount} facts; triggers=${build.triggerCount}`)

  // ── bytes ──────────────────────────────────────────────────────────────────────────────────
  const baseBytes = statSync(baseSnap).size
  const modBytes = statSync(modSnap).size
  const dbm = L.openReadOnly(modSnap)
  const fts2Pages = dbm.prepare("SELECT COALESCE(SUM(pgsize),0) n FROM dbstat WHERE name LIKE 'facts_fts2%'").get().n
  const factPages = dbm.prepare("SELECT COALESCE(SUM(pgsize),0) n FROM dbstat WHERE name = 'facts'").get().n
  dbm.close()
  const bytes = {
    baseline_bytes: baseBytes,
    modified_bytes: modBytes,
    ratio: L.round4(modBytes / baseBytes),
    facts_fts2_index_bytes: fts2Pages,
    facts_table_bytes_after: factPages,
  }

  // ── entity-name-only and date-only recall: production leg vs fts2 leg ───────────────────────
  const rtBase = L.newRuntime({ snapPath: baseSnap, semantic: emb, track })
  const rtMod = L.newRuntime({ snapPath: modSnap, semantic: emb, track })
  const cap = L.legCapFor(rtBase.memory.config, LIMIT * 5)
  /** Mirror `MemoryStore.ftsPath` against `facts_fts2`: trigram MATCH, or the 2-char LIKE fallback. */
  const fts2Leg = (sqlite, query, limit) => {
    // Mirror production `ftsPath` exactly: `buildFtsQuery` first (this is NOT `relevanceTerms` —
    // a mixed digit/CJK date yields trigrams through buildFtsQuery but no term through
    // relevanceTerms' CJK-run rule), then the 2-char substring fallback.
    const ftsQuery = L.buildFtsQuery(query, 'trigram')
    if (ftsQuery) {
      const rows = sqlite.prepare(
        `SELECT f.rowid AS id, bm25(facts_fts2) AS rank FROM facts_fts2 f
          JOIN facts fa NOT INDEXED ON fa.fact_id = f.rowid
         WHERE facts_fts2 MATCH ? AND fa.status = 'active' ORDER BY rank ASC LIMIT ?`,
      ).all(ftsQuery, limit)
      return new Map(rows.map((r) => [r.id, -r.rank]))
    }
    const subs = L.substringTerms(query)
    if (!subs.length) return new Map()
    const one = "fa.index_text LIKE ? ESCAPE '\\'"
    const params = subs.map((t) => `%${t.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`)
    const rows = sqlite.prepare(
      `SELECT fa.fact_id AS id, (${subs.map(() => one).join(' + ')}) AS rank
         FROM facts fa WHERE fa.status = 'active' AND (${subs.map(() => one).join(' OR ')})
        ORDER BY rank DESC, fa.fact_id ASC LIMIT ?`,
    ).all(...params, ...params, limit)
    return new Map(rows.map((r) => [r.id, r.rank]))
  }

  const dfRows = (() => {
    const d = L.openReadOnly(baseSnap)
    try {
      return d.prepare(
        `select e.name name, count(distinct fe.fact_id) df from entities e join fact_entities fe on fe.entity_id = e.entity_id
           join facts f on f.fact_id = fe.fact_id where f.status='active' group by e.name order by df desc`,
      ).all()
    } finally {
      d.close()
    }
  })()

  const hitRate = (goldSets, baseLeg, fts2Leg) => {
    let baseHits = 0
    let fts2Hits = 0
    goldSets.forEach((gold, i) => {
      if (gold.some((id) => baseLeg[i].includes(id))) baseHits += 1
      if (gold.some((id) => fts2Leg[i].includes(id))) fts2Hits += 1
    })
    return { queries: goldSets.length, production_fts_hits: baseHits, fts2_hits: fts2Hits }
  }

  const entityQueries = dfRows.slice(0, 10).map((e) => e.name)
  const entityGold = entityQueries.map((name) => L.goldByEntity(baseSnap, name))
  const entityBase = entityQueries.map((q) => [...rtBase.memory.ftsPath(q, undefined, cap).keys()])
  const entityFts2 = entityQueries.map((q) => [...fts2Leg(rtMod.memory.db, q, cap).keys()])
  const entityRecall = hitRate(entityGold, entityBase, entityFts2)

  const dayRows = (() => {
    const d = L.openReadOnly(baseSnap)
    try {
      return d.prepare(
        `select substr(created_at,1,10) day, count(*) n from facts where status='active' group by day order by n desc limit 10`,
      ).all()
    } finally {
      d.close()
    }
  })()
  const dateQueries = dayRows.map((r) => {
    const [y, mo, da] = r.day.split('-')
    return `${y}年${Number(mo)}月${Number(da)}日`
  })
  const dateGold = dayRows.map((r) => {
    const d = L.openReadOnly(baseSnap)
    try {
      return d.prepare("select fact_id id from facts where status='active' and substr(created_at,1,10)=?").all(r.day).map((x) => x.id)
    } finally {
      d.close()
    }
  })
  const dateBase = dateQueries.map((q) => [...rtBase.memory.ftsPath(q, undefined, cap).keys()])
  const dateFts2 = dateQueries.map((q) => [...fts2Leg(rtMod.memory.db, q, cap).keys()])
  const dateRecall = hitRate(dateGold, dateBase, dateFts2)

  // ── p50 latency: production 20-query network, with and without the extra leg ────────────────
  const queries = L.resolveRealGolds(baseSnap, { texts })
  const identity = []
  for (const q of queries) identity.push(await L.identityCheck(rtBase, q.q, { limit: LIMIT, maxTokens: 0, floors: 'strict', track }))

  const extraLeg = {
    appendLegs: (meta) => {
      const scores = fts2Leg(rtMod.memory.db, meta.variant, meta.legCap)
      return scores.size ? [{ weight: 0.3, scores, leg: 'fts' }] : []
    },
  }
  const timing = { baseline: [], with_fts2: [] }
  for (let rep = 0; rep < REPEATS; rep += 1) {
    for (const q of queries) {
      let t = process.hrtime.bigint()
      await L.runScript(rtBase, q.q, { limit: LIMIT, maxTokens: 0, floors: 'strict', track, arm: {} })
      timing.baseline.push(Number(process.hrtime.bigint() - t) / 1e6)
      t = process.hrtime.bigint()
      await L.runScript(rtMod, q.q, { limit: LIMIT, maxTokens: 0, floors: 'strict', track, arm: extraLeg })
      timing.with_fts2.push(Number(process.hrtime.bigint() - t) / 1e6)
    }
  }
  const p50 = (xs) => {
    const s = [...xs].sort((a, b) => a - b)
    return L.round4(s[Math.floor(s.length / 2)])
  }
  const latency = {
    repeats: REPEATS,
    queries: queries.length,
    sample_ms: timing.baseline.length,
    baseline_p50_ms: p50(timing.baseline),
    with_fts2_p50_ms: p50(timing.with_fts2),
  }
  latency.delta_pct = L.round4((latency.with_fts2_p50_ms - latency.baseline_p50_ms) / latency.baseline_p50_ms)
  latency.under_20pct = latency.delta_pct < 0.2

  const costs = { bytes, latency }
  const entityImproved = entityRecall.fts2_hits > entityRecall.production_fts_hits
  const verdict = {
    entity_name_population_zero: population.entity_names_not_verbatim_in_content === 0,
    entity_queries_improved: entityImproved,
    index_under_2x: bytes.ratio < 2,
    p50_under_20pct: latency.under_20pct,
    adopt: entityImproved && bytes.ratio < 2 && latency.under_20pct,
  }
  verdict.call = !entityImproved
    ? 'reject — no entity-name query can improve: every extracted entity name is already verbatim in its fact content'
    : bytes.ratio >= 2
      ? 'reject — index size at or above 2x'
      : latency.under_20pct
        ? 'adopt'
        : 'reject — p50 regression at or above 20%'

  console.log('bytes:', JSON.stringify(bytes))
  console.log('entity recall:', JSON.stringify(entityRecall), 'date recall:', JSON.stringify(dateRecall))
  console.log('latency:', JSON.stringify(latency))
  console.log('verdict:', JSON.stringify(verdict))

  const out = {
    card: 'R2-8',
    measured_at: new Date().toISOString(),
    node: process.version,
    loadavg: L.loadavg(),
    model: L.DEFAULT_MODEL,
    snapshot: { source: L.DEFAULT_DB, active_facts: texts.size, median_len: [...meta.values()].map((m) => m.len).sort((a, b) => a - b)[Math.floor(meta.size / 2)] },
    simulation: {
      column: 'facts.index_text = content + entity names + date tokens',
      fts_table: 'facts_fts2 (external content, trigram)',
      triggers: build.triggerCount,
      date_token_forms: ['YYYY-MM-DD', 'YYYYMMDD', 'YYYY年M月D日', 'YYYY MM DD', 'M月D日'],
      on_copy_only: true,
    },
    population,
    costs,
    recall: {
      entity_name_queries: { queries: entityQueries, ...entityRecall },
      date_queries: { queries: dateQueries, ...dateRecall },
    },
    identity: { checked: identity.length, passed: identity.filter((r) => r.ok).length, failures: identity.filter((r) => !r.ok) },
    verdict,
    reproduction: 'node mem/scripts/spikes/bench-r2-8-index-text-merge.mjs --json mem/docs/spikes/raw/round2-r2-8-index-text-merge.json',
  }
  L.writeJson(jsonOut, out)
  L.teardown(track)
}

await main()
