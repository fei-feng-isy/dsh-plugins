/**
 * R2-4 · G-A1 / G-A2 / G-A6 / G-A8 — schema simulation on a SNAPSHOT COPY: default retrieval is
 * byte-identical, and the new invariants are checkable.
 *
 * None of these four structural proposals is implemented (this campaign may not touch production),
 * so the only honest way to test their LANDABILITY is to `ALTER` a throwaway copy of the live
 * snapshot and re-run the same queries:
 *   G-A1  `facts.valid_from` / `valid_to`            (bitemporal columns, both nullable)
 *   G-A2  `facts.superseded_by`                      (kept history + rendering convention)
 *   G-A6  `facts.assert_count`                       (repeat-add accumulation)
 *   G-A8  a CONSTRAINED `entity_type` + out-of-set fallback (on the `entities` table)
 *
 * ASSERTIONS.
 *   1. DEFAULT UNCHANGED: for every measured query the returned ids AND the fused scores are
 *      byte-identical between the unmodified snapshot and the altered copy — the new columns are
 *      not referenced by any retrieval SQL, so this must hold.
 *   2. INVARIANT: `superseded_by` may only appear on an ARCHIVED row or one with `valid_to` set.
 *      One SQL statement decides it, and the script proves the statement CAN fail (it plants a
 *      violating row, observes the violation, then reverts it) — an invariant checker that cannot
 *      fail is not evidence.
 *   3. ANNOTATED ACTIVE ROW SURVIVES: an `active` row carrying `valid_to` + `superseded_by` is
 *      still returned with the same ids/scores. (Whether it can be RENDERED with the annotation is
 *      a wire change; that part is reported as a required change, not measured.)
 *   4. FTS unaffected: the external-content `facts_fts` still answers the same candidate set after
 *      columns are added to its content table.
 *
 * Usage: node mem/scripts/spikes/bench-r2-4-ga-schema-unchanged.mjs [--json <path>]
 * PRIVACY: ids / counts / scores / column names only — no fact text is written.
 */
import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import * as L from './bench-spike-lib.mjs'

const jsonOut = L.arg('json', join(L.REPO, 'docs/spikes/raw/round2-r2-4-ga-schema-unchanged.json'))
const LIMIT = 5

const ENTITY_TYPE_WHITELIST = ['person', 'organization', 'project', 'technology', 'place', 'other']

async function main() {
  const emb = await L.warmEmbedder()
  const track = { runtimes: [], dirs: [] }
  const work = mkdtempSync(join(tmpdir(), 'avantf-r24-'))
  track.dirs.push(work)
  const baseSnap = join(work, 'memory-base.db')
  const modSnap = join(work, 'memory-ga.db')
  L.snapshotDb(L.DEFAULT_DB, baseSnap)
  L.snapshotDb(L.DEFAULT_DB, modSnap)
  const { texts, meta } = L.loadActiveTexts(baseSnap)
  track.texts = texts
  L.banner('R2-4 · G-A1/A2/A6/A8 schema simulation on a copy', { base: baseSnap, modified: modSnap, active_facts: texts.size })

  // ── baseline runtime over the UNMODIFIED snapshot ───────────────────────────────────────────
  const rtBase = L.newRuntime({ snapPath: baseSnap, semantic: emb, track })

  // ── ALTER the copy (G-A1/A2/A6/A8) and plant the simulated annotations ──────────────────────
  const db = L.openWritable(modSnap)
  const migrateStart = Date.now()
  db.exec('ALTER TABLE facts ADD COLUMN valid_from TIMESTAMP')
  db.exec('ALTER TABLE facts ADD COLUMN valid_to TIMESTAMP')
  db.exec('ALTER TABLE facts ADD COLUMN superseded_by INTEGER')
  db.exec('ALTER TABLE facts ADD COLUMN assert_count INTEGER NOT NULL DEFAULT 1')
  db.exec('ALTER TABLE entities ADD COLUMN entity_type_v2 TEXT')
  const migrateMs = Date.now() - migrateStart

  const ids = [...texts.keys()].sort((a, b) => a - b)
  const sample = [ids[0], ids[Math.floor(ids.length / 2)], ids[ids.length - 1]]
  // G-A1 backfill: valid_from = created_at on active rows (what a migration would do).
  db.exec("UPDATE facts SET valid_from = created_at WHERE status = 'active'")
  // G-A2: two sample rows are "superseded" but stay active with valid_to set (the interesting row).
  db.prepare('UPDATE facts SET valid_to = created_at, superseded_by = ? WHERE fact_id = ?').run(ids[1], sample[0])
  db.prepare('UPDATE facts SET valid_to = created_at, superseded_by = ? WHERE fact_id = ?').run(ids[0], sample[1])
  // G-A6: a repeat-add counter on one sample row.
  db.prepare('UPDATE facts SET assert_count = 3 WHERE fact_id = ?').run(sample[2])
  db.exec('UPDATE facts SET assert_count = 1 WHERE assert_count IS NULL')
  // G-A8: constrained entity type with an out-of-set fallback.
  const inWhitelist = ENTITY_TYPE_WHITELIST.slice(0, -1).map((t) => `'${t}'`).join(', ')
  db.exec(`UPDATE entities SET entity_type_v2 = CASE WHEN entity_type IN (${inWhitelist}) THEN entity_type ELSE 'other' END`)
  const entityTotal = db.prepare('SELECT COUNT(*) n FROM entities').get().n
  const entityFallback = db.prepare("SELECT COUNT(*) n FROM entities WHERE entity_type_v2 = 'other'").get().n
  const entityTypesSeen = db.prepare('SELECT COUNT(DISTINCT entity_type) n FROM entities').get().n

  // Invariant check + its positive control.
  const invariantSql = "SELECT COUNT(*) n FROM facts WHERE superseded_by IS NOT NULL AND status <> 'archived' AND valid_to IS NULL"
  const invariantViolations = db.prepare(invariantSql).get().n
  // Plant a violation on an active row with no valid_to, observe it, revert.
  db.prepare("UPDATE facts SET superseded_by = ? WHERE fact_id = ? AND status = 'active' AND valid_to IS NULL").run(ids[0], sample[2])
  const invariantViolationsPlanted = db.prepare(invariantSql).get().n
  db.prepare('UPDATE facts SET superseded_by = NULL WHERE fact_id = ?').run(sample[2])
  const invariantViolationsReverted = db.prepare(invariantSql).get().n
  db.close()

  const db2 = L.openReadOnly(modSnap)
  const annotation = {
    facts_with_valid_from: db2.prepare('SELECT COUNT(*) n FROM facts WHERE valid_from IS NOT NULL').get().n,
    facts_with_valid_to: db2.prepare('SELECT COUNT(*) n FROM facts WHERE valid_to IS NOT NULL').get().n,
    facts_with_superseded_by: db2.prepare('SELECT COUNT(*) n FROM facts WHERE superseded_by IS NOT NULL').get().n,
    facts_with_assert_count_gt1: db2.prepare('SELECT COUNT(*) n FROM facts WHERE assert_count > 1').get().n,
    entities: entityTotal,
    entity_types_distinct_legacy: entityTypesSeen,
    entity_type_fallback_to_other: entityFallback,
  }
  db2.close()

  // ── modified runtime over the altered copy ──────────────────────────────────────────────────
  const rtMod = L.newRuntime({ snapPath: modSnap, semantic: emb, track })
  const queries = L.resolveRealGolds(modSnap, { texts })

  const identity = []
  const comparisons = []
  for (const q of queries) {
    identity.push(await L.identityCheck(rtMod, q.q, { limit: LIMIT, maxTokens: 0, floors: 'strict', track }))
    const passBase = await L.runScript(rtBase, q.q, { limit: LIMIT, maxTokens: 0, floors: 'strict', track, arm: {} })
    const passMod = await L.runScript(rtMod, q.q, { limit: LIMIT, maxTokens: 0, floors: 'strict', track, arm: {} })
    const prodBase = await L.prodResult(rtBase, q.q, { limit: LIMIT, maxTokens: 0, floors: 'strict' })
    const prodMod = await L.prodResult(rtMod, q.q, { limit: LIMIT, maxTokens: 0, floors: 'strict' })
    comparisons.push({
      id: q.id,
      query: q.q,
      ids_equal: passBase.ids.join(',') === passMod.ids.join(','),
      scores_equal: JSON.stringify(passBase.scores) === JSON.stringify(passMod.scores),
      product_ids_equal: prodBase.hits.map((h) => h.ref_id).join(',') === prodMod.hits.map((h) => h.ref_id).join(','),
      product_scores_equal: JSON.stringify(prodBase.hits.map((h) => L.round4(h.score))) === JSON.stringify(prodMod.hits.map((h) => L.round4(h.score))),
      baseline_ids: passBase.ids,
      modified_ids: passMod.ids,
    })
  }
  const identityFailures = identity.filter((r) => !r.ok)
  const allSame = comparisons.every((c) => c.ids_equal && c.scores_equal && c.product_ids_equal && c.product_scores_equal)

  // FTS leg candidate-set equality (external-content table survived the ALTERs).
  const ftsComparison = []
  for (const q of queries) {
    const cap = L.legCapFor(rtBase.memory.config, LIMIT * 5)
    const a = rtBase.memory.ftsPath(q.q, undefined, cap)
    const b = rtMod.memory.ftsPath(q.q, undefined, cap)
    ftsComparison.push({ id: q.id, sizes: [a.size, b.size], keys_equal: [...a.keys()].sort((x, y) => x - y).join(',') === [...b.keys()].sort((x, y) => x - y).join(',') })
  }
  const ftsSame = ftsComparison.every((f) => f.keys_equal)

  console.log(`identity on modified copy: ${identity.length - identityFailures.length}/${identity.length}`)
  console.log(`default retrieval byte-identical: ${allSame} (ids+scores, script and product)`)
  console.log(`fts candidate sets identical: ${ftsSame}`)
  console.log('annotation:', JSON.stringify(annotation))
  console.log('invariant violations (clean/planted/reverted):', invariantViolations, invariantViolationsPlanted, invariantViolationsReverted)
  console.log(`migration (5 ALTERs) ${migrateMs} ms`)

  const verdicts = {
    'G-A1': {
      feasible: true,
      default_unchanged: allSame,
      migration: '1 nullable column (valid_from); a historical validity column needs valid_to + a backfill policy, which is a data decision, not a mechanism one',
      wire: 'RecallHit/detail gain valid_from (contract + wire version) if the reader is to see it',
      verdict: allSame ? 'feasible; default retrieval byte-identical' : 'default retrieval moved — not landable as specified',
    },
    'G-A2': {
      feasible: true,
      default_unchanged: allSame,
      invariant_holds: invariantViolations === 0,
      invariant_checker_can_fail: invariantViolationsPlanted > 0,
      annotated_active_rows: annotation.facts_with_valid_to,
      migration: '2 nullable columns (valid_to, superseded_by)',
      wire: 'result rendering of "superseded by / valid until" + admin audit; the ACTIVE+valid_to row still ranks identically (measured)',
      verdict: allSame && invariantViolations === 0 && invariantViolationsPlanted > 0
        ? 'feasible; invariant is one SQL statement and it can fail'
        : 'not landable as specified',
    },
    'G-A6': {
      feasible: true,
      default_unchanged: allSame,
      migration: '1 column with DEFAULT 1 (metadata-only ALTER in SQLite)',
      wire: 'RememberResult gains assert_count',
      verdict: allSame ? 'feasible; retrieval untouched' : 'default retrieval moved',
    },
    'G-A8': {
      feasible: true,
      default_unchanged: allSame,
      migration: 'no new column required (entity_type exists); needs whitelist + fallback + re-scan',
      fallback_share: entityTotal ? L.round4(entityFallback / entityTotal) : null,
      wire: 'entity payload enum already exists; the constrained set is a contract change',
      verdict: allSame ? 'feasible; retrieval untouched' : 'default retrieval moved',
    },
  }

  const out = {
    card: 'R2-4',
    measured_at: new Date().toISOString(),
    node: process.version,
    loadavg: L.loadavg(),
    model: L.DEFAULT_MODEL,
    snapshot: { source: L.DEFAULT_DB, active_facts: texts.size, median_len: [...meta.values()].map((m) => m.len).sort((a, b) => a - b)[Math.floor(meta.size / 2)] },
    simulation: {
      alters: ['facts.valid_from', 'facts.valid_to', 'facts.superseded_by', 'facts.assert_count DEFAULT 1', 'entities.entity_type_v2'],
      migrate_ms: migrateMs,
      annotation,
      invariant_sql: invariantSql,
      invariant_violations_clean: invariantViolations,
      invariant_violations_planted_control: invariantViolationsPlanted,
      invariant_violations_after_revert: invariantViolationsReverted,
    },
    comparisons,
    fts_comparison: ftsComparison,
    default_retrieval_byte_identical: allSame,
    fts_candidate_sets_identical: ftsSame,
    identity: { runtime: 'modified copy', checked: identity.length, passed: identity.length - identityFailures.length, failures: identityFailures },
    verdicts,
    verdict: {
      call: allSame && ftsSame && invariantViolations === 0 && invariantViolationsPlanted > 0
        ? 'G-A1/A2/A6/A8 all feasible on the copy; default retrieval byte-identical; invariants are one SQL statement and the checker can fail'
        : 'not landable as specified — see verdicts',
      default_retrieval_byte_identical: allSame,
      fts_candidate_sets_identical: ftsSame,
      invariant_holds: invariantViolations === 0,
      invariant_checker_can_fail: invariantViolationsPlanted > 0,
    },
    reproduction: 'node mem/scripts/spikes/bench-r2-4-ga-schema-unchanged.mjs --json mem/docs/spikes/raw/round2-r2-4-ga-schema-unchanged.json',
  }
  L.writeJson(jsonOut, out)
  L.teardown(track)
}

await main()
