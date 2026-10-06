/**
 * Round-6 · step 0 — freeze ONE snapshot so every card measures the same corpus.
 *
 * WHY THIS EXISTS. The live memory store is written by concurrent sessions: during this round's
 * own runs it went from 85 to 86 active facts between two measurements (the same drift round 4
 * recorded for a live store). A demand-side baseline that mixes corpora is worthless, so this
 * card `VACUUM INTO`s a single copy, prints its fingerprint and the cards read it through
 * `R6_PINNED`.
 *
 * OUTPUT: `/tmp/dsh-r6/pinned.db` (never committed) + `mem/docs/spikes/raw/round6-s0-pin.json`
 * (counts and a hash, no text).
 *
 * Usage: node mem/scripts/spikes/bench-r6-0-pin.mjs [--json <path>]
 */
import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import * as B from './bench-r6-lib.mjs'

const outPath = B.arg('json', join(B.REPO, 'docs/spikes/raw/round6-s0-pin.json'))

B.banner('round6 · S0 pin one snapshot')
B.ensureTmp()
const pinned = B.tmpPath('pinned.db')
B.snapshotDb(B.DEFAULT_DB, pinned)
const st = statSync(pinned)
const sha = createHash('sha256').update(readFileSync(pinned)).digest('hex')
const db = B.openReadOnly(pinned)
const counts = {
  active_facts: db.prepare("select count(*) c from facts where status = 'active'").get().c,
  archived_facts: db.prepare("select count(*) c from facts where status = 'archived'").get().c,
  triples_total: db.prepare('select count(*) c from triples').get().c,
  entities_total: db.prepare('select count(*) c from entities').get().c,
  fact_entity_links: db.prepare('select count(*) c from fact_entities').get().c,
  contradiction_rows: db.prepare('select count(*) c from contradiction_log').get().c,
}
db.close()
const live = (() => {
  const s = statSync(B.DEFAULT_DB)
  return { mtime: new Date(s.mtimeMs).toISOString(), size: s.size }
})()

const out = {
  card: 'round6-s0-pin',
  generated_at: new Date().toISOString(),
  node: process.version,
  loadavg: B.loadavg(),
  source_live_store: B.DEFAULT_DB,
  live_store_at_pin_time: live,
  pinned_snapshot: { path: pinned, size: st.size, sha256_16: sha.slice(0, 16), sha256: sha },
  counts,
  how_cards_use_it: 'R6_PINNED=/tmp/dsh-r6/pinned.db node mem/scripts/spikes/bench-r6-<n>-*.mjs',
}
B.writeJson(outPath, out)
console.log(`pinned ${pinned}  active=${counts.active_facts} archived=${counts.archived_facts} triples=${counts.triples_total} sha256_16=${sha.slice(0, 16)}`)
