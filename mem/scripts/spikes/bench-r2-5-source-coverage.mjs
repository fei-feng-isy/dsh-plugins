/**
 * R2-5 · G-A7 source coverage — the offline UPPER BOUND, and what production must instrument.
 *
 * THE HONEST BOUNDARY. G-A7 records a `source_ref` per fact so "why do I remember this?" and "which
 * facts did this document produce?" become answerable. Whether a CALLER will pass a source is a
 * behavioural question: it lives in session traffic this offline campaign does not have. What IS
 * measurable offline is an UPPER BOUND PROXY — the share of live facts that could have a source
 * inferred from the managed knowledge base because their text/entities OVERLAP a managed document.
 * If that share is 0 the field has no offline evidence behind it; if it is high the mechanism is
 * worth building even before the behavioural data exists.
 *
 * MEASURED HERE.
 *   - the live corpus: active facts, and how many already carry the ONE provenance-shaped field
 *     that exists today (`facts.mirror_source`) — the `mirror_source` precedent the brief names;
 *   - how many facts' text carries a document-path-shaped token (a weak "came from a file" hint);
 *   - the managed knowledge store (read-only `VACUUM INTO`): documents / chunks / chunk entities,
 *     and the fact share whose entity names or long text shingles overlap it (the actual upper
 *     bound);
 *   - the PRODUCTION-PERIOD metric G-A7 must expose: `stats: facts with source_ref / total active`,
 *     plus the acceptance threshold this report proposes.
 *
 * VERDICT: this card CANNOT return "adopt/reject" — it returns the proxy number and says
 * "production-period only, and THIS is what to instrument".
 *
 * Usage: node mem/scripts/spikes/bench-r2-5-source-coverage.mjs [--json <path>]
 * PRIVACY: counts / ids / share only — no fact or document text is written.
 */
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as L from './bench-spike-lib.mjs'

const jsonOut = L.arg('json', join(L.REPO, 'docs/spikes/raw/round2-r2-5-source-coverage.json'))
const KNOWLEDGE_DB = join(L.homedir(), '.avantf/knowledge/knowledge.db')
const PATH_TOKEN = /(?:^|[\s(（【])(?:[\w.-]+\/)+[\w.-]+\.(?:md|markdown|txt|pdf|docx?|ts|tsx|js|mjs|py|json|ya?ml)\b/i
const SHINGLE = 12

/** 12-char shingles of a text (CJK-safe: plain char windows). */
function shingles(text) {
  const s = new Set()
  for (let i = 0; i + SHINGLE <= text.length; i += 1) s.add(text.slice(i, i + SHINGLE))
  return s
}

function readMemory(snap) {
  const db = L.openReadOnly(snap)
  try {
    const rows = db.prepare(
      `select f.fact_id id, f.content content, f.mirror_source mirror,
              (select group_concat(e.name, '\\u0001') from fact_entities fe join entities e on e.entity_id = fe.entity_id where fe.fact_id = f.fact_id) names
         from facts f where f.status = 'active'`,
    ).all()
    const mirrorValues = new Set(rows.filter((r) => r.mirror != null && String(r.mirror) !== '').map((r) => String(r.mirror)))
    return rows.map((r) => ({
      id: r.id,
      has_mirror_source: r.mirror != null && String(r.mirror) !== '',
      mirror_distinct: mirrorValues.size,
      mirror_max_len: Math.max(0, ...[...mirrorValues].map((v) => v.length)),
      path_like: PATH_TOKEN.test(String(r.content)),
      entities: r.names ? String(r.names).split('\u0001') : [],
      shingles: shingles(String(r.content)),
    }))
  } finally {
    db.close()
  }
}

function readKnowledge(path) {
  if (!existsSync(path)) return { exists: false, documents: 0, chunks: 0, chunk_entities: 0, names: new Set(), shingles: new Set() }
  const tmp = path + `.spike-${process.pid}.db`
  L.snapshotDb(path, tmp)
  const db = L.openReadOnly(tmp)
  try {
    const documents = db.prepare('SELECT COUNT(*) n FROM documents').get().n
    const chunks = db.prepare('SELECT COUNT(*) n FROM doc_chunks').get().n
    const chunkEntities = db.prepare('SELECT COUNT(*) n FROM chunk_entities').get().n
    const names = new Set(db.prepare('SELECT DISTINCT name FROM chunk_entities').all().map((r) => r.name))
    const sh = new Set()
    for (const r of db.prepare('SELECT text FROM doc_chunks').all()) for (const s of shingles(String(r.text))) sh.add(s)
    return { exists: true, documents, chunks, chunk_entities: chunkEntities, names, shingles: sh, source_uris: db.prepare('SELECT COUNT(*) n FROM documents WHERE source_uri IS NOT NULL AND source_uri <> \'\'').get().n }
  } finally {
    db.close()
    rmSync(tmp, { force: true })
  }
}

function main() {
  const work = mkdtempSync(join(tmpdir(), 'avantf-r25-'))
  const snap = join(work, 'memory.db')
  L.snapshotDb(L.DEFAULT_DB, snap)
  const facts = readMemory(snap)
  const kb = readKnowledge(KNOWLEDGE_DB)
  L.banner('R2-5 · G-A7 source coverage upper bound', { active_facts: facts.length, knowledge_db: KNOWLEDGE_DB, kb_exists: kb.exists })

  const overlapping = facts.filter((f) => {
    if (kb.names.size && f.entities.some((n) => kb.names.has(n))) return true
    if (kb.shingles.size) for (const s of f.shingles) if (kb.shingles.has(s)) return true
    return false
  })
  const byEntity = kb.names.size ? facts.filter((f) => f.entities.some((n) => kb.names.has(n))).length : 0
  const byShingle = kb.shingles.size ? facts.filter((f) => {
    for (const s of f.shingles) if (kb.shingles.has(s)) return true
    return false
  }).length : 0

  const counts = {
    active_facts: facts.length,
    facts_with_mirror_source: facts.filter((f) => f.has_mirror_source).length,
    mirror_source_distinct_values: facts[0]?.mirror_distinct ?? 0,
    mirror_source_max_length: facts[0]?.mirror_max_len ?? 0,
    facts_with_path_like_text: facts.filter((f) => f.path_like).length,
  }
  const kbCounts = {
    exists: kb.exists,
    documents: kb.documents,
    doc_chunks: kb.chunks,
    chunk_entities: kb.chunk_entities,
    documents_with_source_uri: kb.source_uris ?? 0,
    distinct_chunk_entity_names: kb.names.size,
  }
  const proxy = {
    definition: 'share of active facts whose entity names OR 12-char text shingles overlap a managed kb document (source inferable)',
    overlapping_facts: overlapping.length,
    share: facts.length ? L.round4(overlapping.length / facts.length) : null,
    by_entity: byEntity,
    by_shingle: byShingle,
  }

  const instrumentation = {
    metric: 'stats.facts_with_source_ref / stats.total_active_facts',
    where: "admin.stats payload (the panel's polling shape), no new tool",
    secondary: [
      'facts_with_valid_to / total (G-A1/A2 usefulness)',
      'facts_with_assert_count_gt1 / total (G-A6 usefulness)',
      'entities_with_constrained_type / total entities (G-A8 coverage)',
      'mirror_source is set / total (the existing precedent, measured here)',
    ],
    acceptance_threshold: '>= 0.30 of active facts carrying source_ref within 2 weeks of the write-side parameter shipping; below that the field is the next mirror_source (a column that exists and is always empty) and should be dropped rather than kept',
    why_offline_cannot_decide: 'no session traffic is available offline: whether a caller passes source_ref is a write-side behaviour, and the managed kb corpus here is empty, so even the overlap upper bound is 0 by construction',
  }

  console.log('counts:', JSON.stringify(counts))
  console.log('kb:', JSON.stringify(kbCounts))
  console.log('proxy:', JSON.stringify(proxy))

  const verdict = {
    proxy_measured: true,
    proxy_upper_bound_share: proxy.share,
    decision: 'production-period only',
    reason: kb.exists && kb.documents > 0
      ? 'the offline corpus allows an overlap proxy but not the behavioural question (does a caller pass source_ref)'
      : 'the managed kb corpus is empty and there is no session traffic, so neither the overlap upper bound nor the behavioural question can be measured offline',
    instrument: instrumentation,
  }

  const out = {
    card: 'R2-5',
    measured_at: new Date().toISOString(),
    node: process.version,
    loadavg: L.loadavg(),
    counts,
    knowledge: kbCounts,
    proxy,
    instrumentation,
    identity: { applicable: false, note: 'this card counts coverage; it runs no retrieval pass, so there is no production arm to identity-check' },
    verdict,
    privacy_note: 'counts and shares only; fact and document text are read for the overlap computation and never written',
    reproduction: 'node mem/scripts/spikes/bench-r2-5-source-coverage.mjs --json mem/docs/spikes/raw/round2-r2-5-source-coverage.json',
  }
  L.writeJson(jsonOut, out)
  L.teardown({ runtimes: [], dirs: [work] })
}

await main()
