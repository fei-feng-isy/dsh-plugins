/**
 * Round-5 shared scaffolding — the "split-then-batch-write" campaign's privacy boundary plus the
 * few helpers every R5 card needs. It builds ON the round-4 boundary rather than restating it:
 * `bench-r4-lib.mjs` already owns the sensitive-pattern superset, the repo-CJK whitelist, the
 * artifact audit and the read-only snapshot/`newRuntime` machinery, and the round-5 brief forbids
 * changing the first four rounds' scripts.
 *
 * WHAT IS NEW IN ROUND 5. Rounds 1–4 never produced *derived text at scale*: round 4 derived
 * queries and entity names. Round 5 splits every long fact into atoms and declares relations, so
 * the volume of content-derived strings goes up by roughly `atoms + edges` per fact — and all of
 * it is still text. The boundary is unchanged in shape:
 *
 *   1. **Anything derived from fact text lives under `/tmp/dsh-r5/` and nowhere else.**
 *      {@link R5_TMP} / {@link writeTmp} / {@link readTmp}.
 *   2. **Repo artifacts are aggregates only** — ids, lengths, counts, ratios, scores, hashes.
 *      `auditArtifact` (round 4) is reused unchanged.
 *   3. **The split outputs are the only place atom text exists**, and every scoring card reads
 *      them from `/tmp` and writes aggregates.
 *
 * @module scripts/spikes/bench-r5-lib
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as R from './bench-r4-lib.mjs'
import * as L from './bench-spike-lib.mjs'

export const R5_TMP = join(tmpdir(), 'dsh-r5')
export const tmpPath = (name) => join(R5_TMP, name)
export function ensureTmp() {
  mkdirSync(R5_TMP, { recursive: true })
  return R5_TMP
}
export function writeTmp(name, obj) {
  ensureTmp()
  const p = tmpPath(name)
  writeFileSync(p, typeof obj === 'string' ? obj : JSON.stringify(obj, null, 1))
  console.log(`  (derived data -> ${p}; never committed)`)
  return p
}
export function readTmp(name) {
  const p = tmpPath(name)
  if (!existsSync(p)) throw new Error(`round5: missing derived artifact ${p} — the split step has not run`)
  return JSON.parse(readFileSync(p, 'utf8'))
}
export const tmpString = (name) => readFileSync(tmpPath(name), 'utf8')

// ─── small stats helpers (every card repeats these; keep them in one place) ──────────────────────
export const pct = (n, d) => (d ? L.round4(n / d) : null)
export const quantile = (arr, q) => (arr.length ? [...arr].sort((a, b) => a - b)[Math.min(arr.length - 1, Math.floor(q * (arr.length - 1)))] : null)
export const median = (arr) => quantile(arr, 0.5)
export const mean = (arr) => (arr.length ? L.round4(arr.reduce((a, b) => a + b, 0) / arr.length) : null)

// ─── the round-5 closed relation enumeration (the brief's suggested five) ────────────────────────
export const RELATION_TYPES = ['same_topic', 'causal', 'temporal', 'subsumes', 'contradicts']

/**
 * Validate one split artifact against the contract the splitting agent was given. Returns
 * `{ok, problems, stats}` — the caller decides whether to fail loud. Text is never returned in
 * `problems` (only ids/lengths), so a validation failure can be printed safely.
 */
export function validateSplit(split, corpusIds) {
  const problems = []
  const seenAtom = new Set()
  const perFact = []
  let atoms = 0
  let edges = 0
  const typeCount = {}
  for (const f of split.facts ?? []) {
    if (!corpusIds.has(f.id)) problems.push({ kind: 'unknown_fact', id: f.id })
    const atomsOf = f.atoms ?? []
    if (atomsOf.length === 0) problems.push({ kind: 'zero_atoms', id: f.id })
    for (const a of atomsOf) {
      atoms += 1
      if (typeof a.text !== 'string' || a.text.trim().length === 0) problems.push({ kind: 'empty_atom', id: f.id, atom_id: a.atom_id })
      else if (a.text.length > 300) problems.push({ kind: 'atom_over_300', id: f.id, atom_id: a.atom_id, len: a.text.length })
      if (a.atom_id) {
        if (seenAtom.has(a.atom_id)) problems.push({ kind: 'duplicate_atom_id', atom_id: a.atom_id })
        seenAtom.add(a.atom_id)
      }
      if (a.source_sentence !== undefined && typeof a.source_sentence !== 'string') problems.push({ kind: 'bad_source_sentence', atom_id: a.atom_id })
    }
    for (const e of f.relations ?? []) {
      edges += 1
      if (!RELATION_TYPES.includes(e.type)) problems.push({ kind: 'unknown_relation_type', id: f.id, type: e.type })
      for (const side of ['from', 'to']) {
        if (!seenAtom.has(e[side]) && !atomsOf.some((a) => a.atom_id === e[side])) problems.push({ kind: 'dangling_edge', id: f.id, side })
      }
      typeCount[e.type] = (typeCount[e.type] ?? 0) + 1
    }
    perFact.push({ id: f.id, atoms: atomsOf.length, edges: (f.relations ?? []).length })
  }
  return { ok: problems.length === 0, problems: problems.slice(0, 50), stats: { atoms, edges, facts: perFact.length, type_count: typeCount, per_fact: perFact } }
}

export { R, L }
// Re-export the round-4 (and through it, the round-1..3) helpers a card may want, so a round-5
// script imports one module.
export const {
  banner, arg, hasFlag, writeJson, snapshotDb, openReadOnly, openWritable, loadActiveTexts,
  newRuntime, warmEmbedder, identityCheck, runScript, prodResult, sameOrder, teardown,
  resolveRealGolds, frozenCases, makeEvalRetriever, degradedSemantic, rssMiB,
  REPO, DEFAULT_DB, normName, cjkRuns, scanSensitiveStrings, auditArtifact, repoCjkWhitelist,
  SENSITIVE_PATTERNS, parseTimeWindow, allTimeExpressions, rm, lib: libPath,
} = R
