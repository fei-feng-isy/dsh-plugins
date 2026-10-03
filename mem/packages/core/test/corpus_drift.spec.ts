import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, unlinkSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildRuntime, type AvantfRuntime } from '../src/index.js'

/**
 * `corpusDrift` — the stat-only half of "reconcile precisely, and only the files that changed".
 *
 * The property that matters is the PAIR: a stamp is a cheap TRIGGER (one `stat` per document, no
 * reads), and `sync` is the JUDGEMENT (it hashes the body). So a stamp change must always surface
 * as "changed" — a false positive costs one wasted hash — while a stamp that did NOT move is never
 * allowed to hide a real edit from anything except the filesystem itself.
 */
describe('KnowledgeStore.corpusDrift', () => {
  let dir: string
  let rt: AvantfRuntime
  let docId: number
  let file: string

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'avantf-drift-'))
    rt = buildRuntime({ dataHome: dir, logger: { info() {}, warn() {}, error() {} } })
    const result = await rt.knowledge.ingest('原始正文', 'design', 'spec', '会改的文档')
    docId = result.doc_id
    file = result.file as string
  })
  afterEach(() => {
    rt.shutdown()
    rmSync(dir, { recursive: true, force: true })
  })

  it('the first call only seeds the baseline', async () => {
    expect(await rt.knowledge.corpusDrift()).toEqual({ changed: [], missing: [], fileSetChanged: false })
  })

  it('reports an external edit, and its own writes are NOT an external edit', async () => {
    await rt.knowledge.corpusDrift() // seed
    // Our own ingest refreshed the baseline, so a second ingest of another document must be quiet.
    await rt.knowledge.ingest('另一篇', 'design', 'spec', '第二篇')
    expect(await rt.knowledge.corpusDrift()).toEqual({ changed: [], missing: [], fileSetChanged: false })

    // An edit that PRESERVES the frontmatter — what the `edit` tool and an editor do.
    writeFileSync(file, readFileSync(file, 'utf8').replace('原始正文', '被外部改过的正文'))
    expect(await rt.knowledge.corpusDrift()).toMatchObject({ changed: [docId], missing: [] })
  })

  it('sees a whole-file overwrite, which destroys the frontmatter', async () => {
    // The bug this pins: the drift check used `pathFor`, which resolves collisions by READING the
    // frontmatter — so a file stripped of it answered with a different path, `stat` returned null,
    // and the edit became invisible to the very check meant to catch it. `basePath` cannot be fooled.
    await rt.knowledge.corpusDrift()
    writeFileSync(file, '整篇覆写，frontmatter 没了')
    const drift = await rt.knowledge.corpusDrift()
    expect(drift.changed).toEqual([docId])
    // And the follow-up sync refuses to guess: the file no longer claims this document.
    const after = await rt.knowledge.sync({ docId, dryRun: true })
    expect(after.missing.map(entry => entry.doc_id)).toEqual([docId])
  })

  it('a stamp move is a trigger, not a verdict: an untouched BODY re-ingests nothing', async () => {
    await rt.knowledge.corpusDrift()
    const later = new Date(Date.now() + 5_000)
    utimesSync(file, later, later) // mtime moves, content identical (what `touch` does)
    expect((await rt.knowledge.corpusDrift()).changed).toEqual([docId])
    // The judgement is the body hash, so the sync that follows finds nothing stale.
    expect(await rt.knowledge.sync({ docId })).toMatchObject({ stale: [], reingested: 0 })
  })

  it('reports a vanished file, and a new file as a corpus-level change', async () => {
    await rt.knowledge.corpusDrift()
    unlinkSync(file)
    expect((await rt.knowledge.corpusDrift()).missing).toEqual([docId])

    await rt.knowledge.corpusDrift() // re-seed with the file gone
    writeFileSync(join(dir, 'knowledge', 'docs', 'design', 'spec', '手放的文件.md'), '正文')
    expect((await rt.knowledge.corpusDrift()).fileSetChanged).toBe(true)
  })

  it('a single-document sync does not walk the tree for orphans', async () => {
    // An unclaimed file exists, but asking about ONE document must not pay for a full scan — that
    // walk is the cost the per-document path exists to avoid.
    writeFileSync(join(dir, 'knowledge', 'docs', 'design', 'spec', '没人认领.md'), '正文')
    const full = await rt.knowledge.sync({ dryRun: true })
    expect(full.orphans.length).toBe(1)
    const one = await rt.knowledge.sync({ docId, dryRun: true })
    expect(one.orphans).toEqual([])
    expect(one.checked).toBe(1)
  })
})

describe('explicit adoption (sync { adopt: true })', () => {
  let dir: string
  let rt: AvantfRuntime
  let docId: number
  let file: string

  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'avantf-adopt-'))
    rt = buildRuntime({ dataHome: dir, logger: { info() {}, warn() {}, error() {} } })
    const result = await rt.knowledge.ingest('原始正文', 'design', 'spec', '会改的文档')
    docId = result.doc_id
    file = result.file as string
  })
  afterEach(() => {
    rt.shutdown()
    rmSync(dir, { recursive: true, force: true })
  })

  const bodyOf = async (): Promise<string> => {
    const detail = await rt.knowledge.detail(docId)
    return (detail?.chunks ?? []).map(chunk => chunk.text).join('\n')
  }

  it('AUTO-adopts a frontmatter-less overwrite, once the body has settled', async () => {
    writeFileSync(file, '整篇覆写后的正文')
    const plan = await rt.knowledge.sync({ dryRun: true })
    // The dry run reports it and does nothing at all.
    expect(plan.unclaimed.map(entry => entry.doc_id)).toEqual([docId])
    expect(plan.adopted).toBe(0)
    expect(await bodyOf()).toContain('原始正文')

    // The real sync adopts it automatically: this is the recovery for an agent that used `write`
    // (whole-file) instead of `edit`, which is what the user asked for.
    const done = await rt.knowledge.sync({})
    expect(done.adopted).toBe(1)
    expect(await bodyOf()).toContain('整篇覆写后的正文')
    // The frontmatter is rewritten, so the document owns its file again.
    expect((await rt.knowledge.sync({ dryRun: true })).unclaimed).toEqual([])
  })

  it('refuses an EMPTY body — the guard that prevents silently emptying a document', async () => {
    writeFileSync(file, '')
    const result = await rt.knowledge.sync({})
    expect(result.adopted).toBe(0)
    // `ingest` has no lower bound (`chunkText('')` returns no chunks), so adopting an empty file
    // would have replaced a good document with nothing at all — silently.
    expect(await bodyOf()).toContain('原始正文')
  })

  it('refuses a path two documents share (sanitize folds distinct titles together)', async () => {
    // `a/b` and `a-b` are different titles but ONE file name after `sanitizeSegment` (a slash
    // becomes a dash), so with the file gone the path can no longer say which document owns it.
    await rt.knowledge.ingest('斜杠标题的正文', 'design', 'spec', 'a/b')
    await rt.knowledge.ingest('破折号标题的正文', 'design', 'spec', 'a-b')
    const clash = rt.knowledge.list().find(doc => doc.title === 'a/b')
    const clashPath = rt.knowledge.docFilePath(clash?.doc_id as number) as string
    expect(clashPath).not.toBeNull()
    unlinkSync(clashPath)
    writeFileSync(clashPath, '无主内容')
    const plan = await rt.knowledge.sync({ dryRun: true })
    // Two documents want that path, so it is reported by NEITHER as adoptable...
    expect(plan.unclaimed).toEqual([])
    expect((await rt.knowledge.sync({})).adopted).toBe(0)
  })

  it('refuses a file that another document claims', async () => {
    const other = await rt.knowledge.ingest('别人的正文', 'design', 'spec', '第二篇')
    // Copy the second document's file over the first one's path, frontmatter and all: that is a
    // collision, not an adoption — guessing would let one document overwrite another.
    writeFileSync(file, readFileSync(other.file as string, 'utf8'))
    const result = await rt.knowledge.sync({ docId, adopt: true })
    expect(result.adopted).toBe(0)
    expect(await bodyOf()).toContain('原始正文')
  })
})
