/**
 * Child-process helper for the multi-process presence test (TRUST_MODEL.md §2.1/§9:
 * "两进程并发只推进一次"). Two of these run as separate OS processes against the
 * same DB; each re-establishes a 90-day gap and then calls `advancePresence`, so a
 * read-modify-write that is not atomic shows up as a LOST UPDATE.
 *
 * Run through vite-node (the runner vitest itself uses) so it imports the real
 * TypeScript sources — no build step and no duplicated logic.
 *
 * Env: AVANTF_CHILD_DB (db path), AVANTF_CHILD_BARRIER (dir for rendezvous markers),
 *      AVANTF_CHILD_ROUNDS (iterations).
 */
import { readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { openMemoryDb } from '../../src/db/conn.js'
import { advancePresence, readClock } from '../../src/lifecycle/presence.js'

const dbPath = process.env['AVANTF_CHILD_DB']
const barrierDir = process.env['AVANTF_CHILD_BARRIER']
const rounds = Number(process.env['AVANTF_CHILD_ROUNDS'] ?? '1500')
const peers = Number(process.env['AVANTF_CHILD_PEERS'] ?? '2')
if (!dbPath) throw new Error('AVANTF_CHILD_DB is required')

const db = openMemoryDb(dbPath)

// Rendezvous: both processes must be LOADED and ready before either starts writing;
// otherwise they merely take turns after their (very different) vite-node startups
// and the test would pass even on a non-atomic implementation.
if (barrierDir) {
  writeFileSync(join(barrierDir, `${String(process.pid)}.ready`), '')
  const deadline = Date.now() + 30_000
  while (readdirSync(barrierDir).length < peers) {
    if (Date.now() > deadline) throw new Error('barrier timeout: peer never became ready')
  }
  const go = Date.now() + 250
  while (Date.now() < go) { /* spin to a shared start instant */ }
}

const counted: number[] = []
const clocks: number[] = []
for (let i = 0; i < rounds; i++) {
  // Re-establish a 90-day gap so every presence SHOULD count exactly one day.
  db.prepare("UPDATE avantf_stats SET value = datetime('now', '-90 days') WHERE key = 'trust_last_seen'").run()
  const before = readClock(db)
  const res = advancePresence(db, { gapCapDays: 1 })
  counted.push(res.counted)
  clocks.push(before, res.clock)
}

process.stdout.write(JSON.stringify({ counted, clocks }))
db.close()
