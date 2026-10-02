import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const CLI = join(here, '..', 'lib', 'index.js')

function run(args: string[], home: string): string {
  return execFileSync('node', [CLI, ...args], {
    env: { ...process.env, AVANTF_HOME: home },
    encoding: 'utf8',
  })
}

/** Run a command expected to FAIL (non-zero exit), capturing its status and stderr. */
function runFail(args: string[], home: string): { status: number; stderr: string } {
  try {
    execFileSync('node', [CLI, ...args], { env: { ...process.env, AVANTF_HOME: home }, encoding: 'utf8' })
    return { status: 0, stderr: '' }
  } catch (error) {
    const failure = error as { status?: number; stderr?: string }
    return { status: failure.status ?? -1, stderr: String(failure.stderr ?? '') }
  }
}

/**
 * Every string reachable from the CLI's RAW stdout must be well-formed.
 *
 * `JSON.parse` alone proves nothing here: JavaScript's parser accepts the `"\ud800"` escape a lone
 * surrogate serializes to, while a strict parser rejects it. So the assertion walks the parsed
 * value.
 */
function expectWellFormedEverywhere(value: unknown, path = '$'): void {
  if (typeof value === 'string') {
    expect(value.isWellFormed(), `${path}: ${JSON.stringify(value)}`).toBe(true)
    return
  }
  if (Array.isArray(value)) {
    value.forEach((item, i) => expectWellFormedEverywhere(item, `${path}[${i}]`))
    return
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      expect(key.isWellFormed(), `${path} key`).toBe(true)
      expectWellFormedEverywhere(item, `${path}.${key}`)
    }
  }
}

describe('CLI', () => {
  let home: string
  beforeAll(() => {
    home = mkdtempSync(join(tmpdir(), 'avf-cli-'))
  })

  it('add/search/list round-trips a fact', () => {
    const add = JSON.parse(run(['add', '张伟管理李娜'], home))
    expect(add.is_new).toBe(true)

    const search = JSON.parse(run(['search', '理李娜'], home))
    expect(search.hits.length).toBeGreaterThan(0)
    expect(search.hits[0].text).toContain('张伟')

    const list = JSON.parse(run(['list'], home))
    expect(list.facts.length).toBeGreaterThan(0)
  })

  it('kb ingest + list round-trips a document', () => {
    // `design` is in the shipped `knowledge.domains` allowlist; a NEW domain is refused host-side.
    run(['kb', 'ingest', '平台组负责统一网关。', '--domain', 'design', '--source', 'gw.md'], home)
    const docs = JSON.parse(run(['kb', 'list', '--domain', 'design'], home))
    expect(docs.length).toBeGreaterThan(0)
  })

  it('kb ingest without --source lands the document under `default`', () => {
    run(['kb', 'ingest', '缺省来源的正文。', '--domain', 'design'], home)
    const docs = JSON.parse(run(['kb', 'list', '--domain', 'design'], home)) as { source: string }[]
    expect(docs.some((doc) => doc.source === 'default')).toBe(true)
  })

  it('kb ingest refuses an unconfirmed replace, and --overwrite performs it', () => {
    // The title is derived from the body's first line, so these two share the identity `(design,
    // default, 同一标题)`.
    const first = JSON.parse(run(['kb', 'ingest', '同一标题\n\n正文甲。', '--domain', 'design', '--source', 'cliOw'], home)) as { doc_id: number }
    const refused = runFail(['kb', 'ingest', '同一标题\n\n正文乙。', '--domain', 'design', '--source', 'cliOw'], home)
    expect(refused.status).not.toBe(0)
    expect(refused.stderr).toContain('--overwrite')
    // Nothing was written by the refused call.
    const before = JSON.parse(run(['kb', 'detail', String(first.doc_id)], home)) as { chunks: { text: string }[] }
    expect(before.chunks.map((c) => c.text).join('')).toContain('正文甲')

    const applied = JSON.parse(run(['kb', 'ingest', '同一标题\n\n正文乙。', '--domain', 'design', '--source', 'cliOw', '--overwrite'], home)) as { doc_id: number }
    expect(applied.doc_id).toBe(first.doc_id)
    const after = JSON.parse(run(['kb', 'detail', String(first.doc_id)], home)) as { chunks: { text: string }[] }
    expect(after.chunks.map((c) => c.text).join('')).toContain('正文乙')
    expect(after.chunks.map((c) => c.text).join('')).not.toContain('正文甲')
  })

  it('contradict_check returns a (possibly empty) array', () => {
    JSON.parse(run(['add', '老王喜欢小红'], home))
    JSON.parse(run(['add', '老王不喜欢小红'], home))
    const res = JSON.parse(run(['contradict'], home))
    expect(Array.isArray(res)).toBe(true)
  })

  it('resolve lists the open conflicts (ids included) and then adjudicates one', () => {
    const a = JSON.parse(run(['add', '老王喜欢小红'], home))
    const b = JSON.parse(run(['add', '老王不喜欢小红'], home))
    // No id: the sweep reports pairs, but a VERDICT needs the row id, so listing is the default.
    const open = JSON.parse(run(['resolve'], home)) as { contradiction_id: number; fact_a: number; fact_b: number }[]
    expect(open).toHaveLength(1)
    const verdict = JSON.parse(run(['resolve', String(open[0]!.contradiction_id), '--loser', String(b.fact_id)], home))
    expect(verdict).toMatchObject({ resolved: true, archived_loser: b.fact_id })
    // The wrong statement left the live corpus; the surviving one is still listed.
    const active = JSON.parse(run(['list'], home)) as { facts: { fact_id: number }[] }
    const ids = active.facts.map((f) => f.fact_id)
    expect(ids).toContain(a.fact_id)
    expect(ids).not.toContain(b.fact_id)
    expect(JSON.parse(run(['resolve'], home))).toHaveLength(0)
  })

  it('query blends memory facts and kb chunks; flag values do not leak into positionals', () => {
    const out = JSON.parse(run(['query', '张伟', '--limit', '5'], home))
    expect(Array.isArray(out.hits)).toBe(true)
    expect(out.hits.length).toBeGreaterThan(0)
    expect(out.hits.length).toBeLessThanOrEqual(5)
  })

  it('ask answers directionally via triples', () => {
    const out = JSON.parse(run(['ask', '李娜管理谁'], home))
    expect(Array.isArray(out.hits)).toBe(true)
  })

  it('probe and related run the entity paths', () => {
    const probe = JSON.parse(run(['probe', '张伟'], home))
    expect(Array.isArray(probe.hits)).toBe(true)
    const related = JSON.parse(run(['related', '张伟'], home))
    expect(Array.isArray(related)).toBe(true)
  })

  it('related honors --category (contract field was previously ignored)', () => {
    run(['add', '张伟管理支付网关', '--category', 'project'], home)
    run(['add', '张伟熟悉运维手册', '--category', 'tool'], home)
    const all = JSON.parse(run(['related', '张伟'], home)) as { entity: string }[]
    const allNames = all.map((r) => r.entity)
    expect(allNames).toContain('网关') // from the project fact
    expect(allNames).toContain('运维') // from the tool fact
    const scoped = JSON.parse(run(['related', '张伟', '--category', 'project'], home)) as { entity: string }[]
    expect(scoped.map((r) => r.entity)).toContain('网关')
    expect(scoped.map((r) => r.entity)).not.toContain('运维')
  })

  it('maintenance keeps the legacy report keys and adds the trust detail (D10)', () => {
    const res = JSON.parse(run(['maintenance'], home)) as Record<string, unknown>
    for (const key of ['decayed', 'archived_ttl', 'archived_age', 'purged', 'purged_ids', 'archived_ids']) {
      expect(res).toHaveProperty(key)
    }
    for (const key of ['settled', 'clock', 'archived_forgot', 'archived_idle', 'skipped']) {
      expect(res).toHaveProperty(key)
    }
    // The derived-state sweep rides the same command, under its OWN key: `rebuilt` counts the
    // facts re-extracted by this invocation (the CLI drains the remainder in batches, so it can
    // exceed one batch), `deferred` is what is still stale. A fresh store owes nothing.
    expect(res['entities']).toEqual({ rebuilt: 0, deferred: 0, skipped: false })
    // …and so does the conflict queue's bounded drain (`checked` rows completed, `logged` pairs,
    // `pending` left for the next call). The CLI is the surface that loops it to completion.
    //
    // `pending` is the REAL backlog, not "what this call selected": this store has facts with no
    // `semantic_vector` (no embedder in a test), and the queue predicate requires one, so the
    // selection is empty while those rows genuinely wait. Reporting 0 here is what made
    // `maintenance` say "queue empty" on a store whose `trust` said otherwise.
    const conflicts = res['conflicts'] as { checked: number; logged: number; pending: number }
    expect(conflicts).toMatchObject({ checked: 0, logged: 0 })
    // The CLI still terminates its drain loop: a non-zero `pending` whose pass completes nothing
    // breaks out rather than spinning (that guard is what the loop is for).
    expect(conflicts.pending).toBeGreaterThan(0)
  })

  it('trust / pin / unpin manage permanent memory', () => {
    const add = JSON.parse(run(['add', '永久记忆测试事实'], home)) as { fact_id: number }
    expect(JSON.parse(run(['pin', String(add.fact_id)], home))).toBe(true)

    const diag = JSON.parse(run(['trust'], home)) as { clock: number; pinned: number; active: number; reinforced_today: number }
    expect(typeof diag.clock).toBe('number')
    expect(diag.pinned).toBeGreaterThanOrEqual(1)
    expect(diag.active).toBeGreaterThanOrEqual(1)
    expect(typeof diag.reinforced_today).toBe('number')

    const show = JSON.parse(run(['show', String(add.fact_id)], home)) as { pinned: boolean; trust_score: number; remaining_days: number | null }
    expect(show.pinned).toBe(true)
    expect(show.trust_score).toBe(1)
    expect(show.remaining_days).toBeNull() // permanent: nothing left to forget

    expect(JSON.parse(run(['unpin', String(add.fact_id)], home))).toBe(true)
    const after = JSON.parse(run(['show', String(add.fact_id)], home)) as { pinned: boolean }
    expect(after.pinned).toBe(false)
  })

  it('vectors diagnose reports index health', () => {
    const diag = JSON.parse(run(['vectors'], home))
    expect(diag.total).toBeGreaterThan(0)
    expect(typeof diag.indexed).toBe('number')
    expect(typeof diag.unindexed).toBe('number')
  })

  it('kb reindex reports the processed chunk count', () => {
    const out = JSON.parse(run(['kb', 'reindex'], home))
    expect(out.chunks).toBeGreaterThan(0)
  })

  it('add with a lone surrogate prints strictly parseable, well-formed JSON', () => {
    // A real subprocess, capturing the RAW stdout (never the function's return value). Note that
    // Node encodes argv as UTF-8, so the lone surrogate below reaches the child as U+FFFD — the
    // assertion is still exactly the one that matters: what the CLI printed is well-formed JSON.
    const content = 'CLI\uD800半\uDC00个 🐟 "引号" \\ 反斜杠 \n 换行 \t 制表'
    const raw = run(['add', content], home)
    const parsed = JSON.parse(raw) as { fact_id: number }
    expectWellFormedEverywhere(parsed)
    expect(raw).not.toContain('\\ud800')
    expect(raw).not.toContain('\\udc00')
  })

  it('add normalizes to NFC end-to-end (decomposed input comes back composed)', () => {
    // `e` + combining acute is representable in argv (unlike a lone surrogate), so this exercises
    // the write-side normalization through the real process boundary.
    const added = JSON.parse(run(['add', 'cafe\u0301 记忆'], home)) as { fact_id: number }
    const shown = JSON.parse(run(['show', String(added.fact_id)], home)) as { content: string }
    expect(shown.content).toBe('café 记忆')
    expect(shown.content).not.toContain('\u0301')
    expectWellFormedEverywhere(shown)
  })

  afterAll(() => {
    rmSync(home, { recursive: true, force: true })
  })
})
