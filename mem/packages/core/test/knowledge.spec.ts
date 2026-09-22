import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { chmodSync, closeSync, ftruncateSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { execFileSync, spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildRuntime, type AvantfRuntime } from '../src/runtime.js'
import type { Db } from '../src/db/port.js'
import { openKnowledgeDb } from '../src/db/knowledge.js'
import { contentHash } from '../src/db/hash.js'
import { float32ToBytes, vectorSpaceId } from '../src/db/vectors.js'
import { ENTITY_EXTRACTOR_VERSION } from '../src/entities/extract.js'
import type { SemanticBackend } from '@avantf/mem-core'
import { DEFAULT_KB_SOURCE, KbUnion, type KbConflictReport, type KbRequest } from '@avantf/mem-contract'
import { textlessPdf, tinyPdf } from './fixtures/pdf.js'
import { docxBytes, plainZipBytes } from './fixtures/office.js'
import { allowAnyDomain } from './helpers.js'

let dir: string
let rt: AvantfRuntime

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'avantf-kb-'))
  allowAnyDomain(dir)
  rt = buildRuntime({ dataHome: dir })
})
afterEach(() => {
  rt.shutdown()
  rmSync(dir, { recursive: true, force: true })
})

/** The temp data home is outside the process workspace, so the ingestion boundary must be opened explicitly. */
function openBoundary(): void {
  allowAnyDomain(dir, 'ingest:\n  allow_outside_workspace: true\n')
  rt.shutdown()
  rt = buildRuntime({ dataHome: dir })
}

/**
 * The request the CONTRACT produces for a paste the caller did not name: `source` is defaulted and
 * `title` is omitted, which is exactly the shape the UI, CLI and MCP surfaces send. Parsing through
 * `KbUnion` (rather than typing the literal) keeps the `source` default in the loop — the store's
 * own default is for callers that bypass the contract.
 */
function paste(text: string, domain: string, title?: string): KbRequest {
  return KbUnion.parse({ action: 'ingest', text, domain, ...(title === undefined ? {} : { title }) })
}

/**
 * The add-only runtime face exactly as the model's `kb_add` calls it — the same request shape,
 * never the replace mode. Used to pin that "only add" is an ENGINE mode, not a request field.
 */
function add(text: string, domain: string, title?: string): Promise<unknown> {
  return rt.kbAdd({ source: DEFAULT_KB_SOURCE, domain, text, ...(title === undefined ? {} : { title }) })
}

/** MAX_DOC_BYTES in knowledge.ts (MAX_DOC_CHARS × 4), +1 so it is over the cap. */
const OVER_CAP_BYTES = 80_000_001

const require = createRequire(import.meta.url)
const here = dirname(fileURLToPath(import.meta.url))
const fifoChild = join(here, 'fixtures', 'fifo_child.ts')
/** vite-node ships with vitest — resolve it through vitest's own dependency tree. */
const viteNodeCli = join(
  dirname(require.resolve('vite-node/package.json', { paths: [require.resolve('vitest/package.json')] })),
  'dist',
  'cli.mjs',
)

interface FifoChildResult {
  code: number | null
  timedOut: boolean
  stdout: string
  stderr: string
}

/**
 * Run the FIFO reads in a CHILD with a hard kill deadline. A synchronous `readFileSync`
 * on a FIFO cannot be interrupted in-process, so an in-process test would hang the whole
 * suite (and CI) instead of failing — see `fixtures/fifo_child.ts`.
 */
function runFifoChild(env: Record<string, string>, timeoutMs: number): Promise<FifoChildResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [viteNodeCli, fifoChild], {
      env: { ...process.env, AVANTF_MEM_AUTO_DOWNLOAD: '0', ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    let timedOut = false
    child.stdout.on('data', (d: Buffer) => { stdout += String(d) })
    child.stderr.on('data', (d: Buffer) => { stderr += String(d) })
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL') }, timeoutMs)
    child.on('error', (error) => { clearTimeout(timer); resolve({ code: null, timedOut, stdout, stderr: `${stderr}\n${error.message}` }) })
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, timedOut, stdout, stderr }) })
  })
}

describe('knowledge store', () => {
  it('ingests a document into domain/source chunks', async () => {
    const text = '平台组负责统一网关。平台组负责风控引擎。风控引擎依赖规则库。'
    const res = (await rt.kb({ action: 'ingest', text, domain: 'tech', source: 'architecture.md', title: '架构说明' })) as { doc_id: number; chunks: number }
    expect(res.doc_id).toBeGreaterThan(0)
    expect(res.chunks).toBeGreaterThan(0)
    const list = (await rt.kb({ action: 'list', domain: 'tech' })) as unknown[]
    expect(list.length).toBe(1)
  })

  it('ingest with source_uri READS the file (never stores the path as the body)', async () => {
    // The temp data home is outside the process workspace, so the ingestion boundary
    // must be opened explicitly for this test (see `ingest_guard.ts`).
    const file = join(dir, 'spec.md')
    writeFileSync(file, '# 接口规范\n\n平台组负责统一网关的鉴权。')
    allowAnyDomain(dir, 'ingest:\n  allow_outside_workspace: true\n')
    rt.shutdown()
    rt = buildRuntime({ dataHome: dir })
    const res = (await rt.kb({ action: 'ingest', source_uri: file, domain: 'tech', source: 'spec.md' })) as { doc_id: number; chunks: number }
    expect(res.chunks).toBeGreaterThan(0)
    const detail = (await rt.kb({ action: 'detail', doc_id: res.doc_id })) as { title: string; source_uri: string | null; chunks: { text: string; headings_path: string }[] }
    // The recorded path is the REALPATH (what was actually read), not the input spelling.
    expect(detail.source_uri).toBe(realpathSync(file))
    expect(detail.title).toBe('spec.md') // default title = basename
    const body = detail.chunks.map((c) => c.text).join('\n')
    expect(body).toContain('平台组负责统一网关')
    expect(body).not.toContain(file) // the path itself is not the body
    expect(detail.chunks[0].headings_path).toBe('接口规范')
  })

  it('lists and details a document', async () => {
    await rt.kb({ action: 'ingest', text: '订单服务使用 PostgreSQL 作为主库。', domain: 'tech', source: 'db.md' })
    const list = (await rt.kb({ action: 'list', source: 'db.md' })) as { doc_id: number }[]
    const detail = (await rt.kb({ action: 'detail', doc_id: list[0].doc_id })) as { doc_id: number; chunks: unknown[] }
    expect(detail.chunks.length).toBeGreaterThan(0)
  })

  it('pages the document list with limit/offset (the UI reads one page at a time)', async () => {
    for (const title of ['一', '二', '三']) {
      await rt.kb({ action: 'ingest', text: `${title} 的内容`, domain: 'tech', source: `doc-${title}.md` })
    }
    const all = (await rt.kb({ action: 'list' })) as { doc_id: number }[]
    expect(all).toHaveLength(3) // no limit ⇒ the historical "everything" the CLI/MCP surfaces read

    const first = (await rt.kb({ action: 'list', limit: 2 })) as { doc_id: number }[]
    const second = (await rt.kb({ action: 'list', limit: 2, offset: 2 })) as { doc_id: number }[]
    expect(first).toHaveLength(2)
    expect(second).toHaveLength(1)
    // Pages partition the corpus in the same order — no overlap, nothing skipped.
    expect([...first, ...second].map(doc => doc.doc_id)).toEqual(all.map(doc => doc.doc_id))
    // A full page is the UI's "there may be more" signal; the last (short) page ends the scroll.
    expect((await rt.kb({ action: 'list', limit: 2, offset: 3 })) as unknown[]).toHaveLength(0)
  })

  it('removes a document and its chunks stop matching', async () => {
    const res = (await rt.kb({ action: 'ingest', text: '日志收集走 ELK 栈。', domain: 'ops', source: 'log.md' })) as { doc_id: number }
    const removed = (await rt.kb({ action: 'remove', doc_id: res.doc_id })) as boolean
    expect(removed).toBe(true)
    expect((await rt.kb({ action: 'list' })) as unknown[]).toHaveLength(0)
    const hits = await rt.knowledge.search('日志收集')
    expect(hits).toHaveLength(0)
  })

  it('searches chunks by FTS', async () => {
    await rt.kb({ action: 'ingest', text: '监控使用 Prometheus 和 Grafana。', domain: 'ops', source: 'monitor.md' })
    await rt.kb({ action: 'ingest', text: '日志收集走 ELK 栈。', domain: 'ops', source: 'log.md' })
    const hits = await rt.knowledge.search('Prometheus')
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0].kind).toBe('doc_chunk')
    expect(hits[0].text).toContain('监控')
  })

  it('honors domain/source filters on every retrieval path', async () => {
    await rt.kb({ action: 'ingest', text: '监控使用 Prometheus 和 Grafana。', domain: 'ops', source: 'monitor.md' })
    await rt.kb({ action: 'ingest', text: 'Prometheus 是一个指标系统。', domain: 'tech', source: 'notes.md' })
    const onlyTech = await rt.knowledge.search('Prometheus', { domain: 'tech' })
    expect(onlyTech.length).toBeGreaterThan(0)
    for (const hit of onlyTech) expect(hit.domain).toBe('tech')
    const onlyMonitor = await rt.knowledge.search('Prometheus', { source: 'monitor.md' })
    expect(onlyMonitor.length).toBeGreaterThan(0)
    for (const hit of onlyMonitor) expect(hit.source).toBe('monitor.md')
  })

  it('carries domain/source verbatim even when the names contain ":"', async () => {
    // `source_ref` is `domain:source:docId:idx`: with a ":" in either name the string
    // cannot be split back apart, so the pair must come from the documents row.
    await rt.kb({ action: 'ingest', text: '网关由平台组维护。', domain: 'a:b', source: 'spec:v1.md' })
    const hits = await rt.knowledge.search('网关')
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0].domain).toBe('a:b')
    expect(hits[0].source).toBe('spec:v1.md')
    // …and the filters still find it
    expect((await rt.knowledge.search('网关', { domain: 'a:b' })).length).toBeGreaterThan(0)
    expect((await rt.knowledge.search('网关', { source: 'spec:v1.md' })).length).toBeGreaterThan(0)
    expect(await rt.knowledge.search('网关', { source: 'v1.md' })).toHaveLength(0)
  })

  it('matches by entities extracted at INGEST time (jaccard path, no corpus rescan)', async () => {
    await rt.kb({ action: 'ingest', text: '风控引擎依赖规则库运行。', domain: 'tech', source: 'arch.md' })
    const hits = await rt.knowledge.search('风控引擎')
    expect(hits.length).toBeGreaterThan(0)
    expect(hits[0].text).toContain('风控')
    expect(hits[0].entities.length).toBeGreaterThan(0) // ingest-time entities are surfaced
  })

  // Root ignores the mode bits, so a chmod-based failure cannot be staged there.
  it.skipIf(process.getuid?.() === 0)('reports skipped files instead of dropping them silently', async () => {
    // The import boundary lives in the knowledge store config; the temp data home is
    // outside the process workspace, so it has to be opened explicitly.
    allowAnyDomain(dir, 'ingest:\n  allow_outside_workspace: true\n')
    rt.shutdown()
    rt = buildRuntime({ dataHome: dir })

    const src = join(dir, 'import-src')
    mkdirSync(src, { recursive: true })
    writeFileSync(join(src, 'ok.md'), '平台组负责统一网关。')
    const blocked = join(src, 'blocked.md')
    writeFileSync(blocked, '这段读不出来。')
    chmodSync(blocked, 0o000)
    try {
      const res = (await rt.kb({ action: 'import', paths: [src], domain: 'tech', source: 'docs' })) as {
        imported: { doc_id: number }[]
        failed: { path: string; error: string }[]
      }
      // The old shape returned only the successes, so a half-failed import looked complete.
      expect(res.imported).toHaveLength(1)
      expect(res.failed.map((f) => f.path)).toEqual([blocked])
      expect(res.failed[0]?.error).toMatch(/permission denied/i)
      expect((await rt.knowledge.search('网关')).length).toBeGreaterThan(0)
    } finally {
      chmodSync(blocked, 0o600)
    }
  })

  it('reindex reports the chunk count and can be scoped to a domain', async () => {
    await rt.kb({ action: 'ingest', text: '平台组负责统一网关。', domain: 'tech', source: 'a.md' })
    await rt.kb({ action: 'ingest', text: '日志收集走 ELK 栈。', domain: 'ops', source: 'b.md' })
    const all = (await rt.kb({ action: 'reindex' })) as { chunks: number }
    expect(all.chunks).toBeGreaterThanOrEqual(2)
    const scoped = (await rt.kb({ action: 'reindex', domain: 'tech' })) as { chunks: number }
    expect(scoped.chunks).toBe(1)
  })

  it('re-ingesting the same domain/source/title replaces chunks', async () => {
    // REPLACE-by-identity lives in `store.ingest`, which is what `ingestUri`, `importPaths`,
    // `sync`'s re-ingest and `adopt` drive. The paste entry point (`rt.kb` with `text`) is
    // add-only, so this now targets the store directly — the semantics being pinned are unchanged.
    await rt.knowledge.ingest('旧内容：网关由平台组维护。', 'tech', 'gw.md', 'gw')
    const res = await rt.knowledge.ingest('新内容：网关由基础设施组维护。', 'tech', 'gw.md', 'gw')
    const detail = (await rt.kb({ action: 'detail', doc_id: res.doc_id })) as { chunks: { text: string }[] }
    const body = detail.chunks.map((c) => c.text).join('')
    expect(body).toContain('基础设施组')
    expect(body).not.toContain('平台组')
    const hits = await rt.knowledge.search('旧内容')
    expect(hits.filter((x) => x.text.includes('旧内容'))).toHaveLength(0)
  })

  it('two untitled pastes into one domain produce two documents (no silent overwrite)', async () => {
    const firstReq = paste('第一篇：网关由平台组维护。', 'ops')
    // The contract defaults `source`; the title is what the store must derive from the body.
    expect(firstReq).toMatchObject({ source: DEFAULT_KB_SOURCE })
    // The helper (and therefore this case) genuinely omits `title`: leave it to the store.
    expect(firstReq).not.toHaveProperty('title')
    const first = (await rt.kb(firstReq)) as { doc_id: number; file?: string }
    const second = (await rt.kb(paste('第二篇：日志走 ELK 栈。', 'ops'))) as { doc_id: number; file?: string }

    expect(second.doc_id).not.toBe(first.doc_id)
    const rows = (await rt.kb({ action: 'list', domain: 'ops' })) as { doc_id: number }[]
    expect(rows.map((r) => r.doc_id).sort()).toEqual([first.doc_id, second.doc_id].sort())

    // The first document's body AND its managed file both survive the second paste.
    const detail = (await rt.kb({ action: 'detail', doc_id: first.doc_id })) as { title: string; chunks: { text: string }[] }
    expect(detail.title).toBe('第一篇：网关由平台组维护。') // derived from the first non-empty line
    expect(detail.chunks.map((c) => c.text).join('')).toContain('平台组')
    const file = rt.knowledge.docFilePath(first.doc_id)
    expect(file).not.toBeNull()
    expect(readFileSync(file!, 'utf8')).toContain('平台组')
  })

  it('an unconfirmed replace-mode paste of the same identity writes nothing and reports the conflict', async () => {
    const first = (await rt.kb(paste('同一标题\n\n正文甲。', 'ops'))) as { doc_id: number }
    const file = rt.knowledge.docFilePath(first.doc_id)
    const before = (await rt.kb({ action: 'detail', doc_id: first.doc_id })) as { chunks: { text: string }[] }

    const report = (await rt.kb(paste('同一标题\n\n正文乙。', 'ops'))) as KbConflictReport
    expect(report.conflict).toBe(true)
    expect(report.error).toContain(`doc_id=${String(first.doc_id)}`)
    expect(report.error).toContain('同一标题')
    // The structured half the UI's dialog and the CLI read.
    expect(report.would_overwrite).toBe(1)
    expect(report.would_add).toBe(0)
    expect(report.conflicts).toEqual([{ doc_id: first.doc_id, title: '同一标题', path: file }])

    // Nothing of the first document was rewritten.
    const after = (await rt.kb({ action: 'detail', doc_id: first.doc_id })) as { chunks: { text: string }[] }
    expect(after.chunks.map((c) => c.text).join('')).toBe(before.chunks.map((c) => c.text).join(''))
    expect(readFileSync(file!, 'utf8')).toContain('正文甲')
  })

  it('the add-only face refuses the same paste, naming the collided document and the file to edit', async () => {
    const first = (await add('甲', 'ops', '显式标题')) as { doc_id: number }
    const file = rt.knowledge.docFilePath(first.doc_id)

    const error = await add('乙', 'ops', '显式标题')
      .then(() => null, (reason: unknown) => reason as Error)
    expect(error).toBeInstanceOf(Error)
    const message = (error as Error).message
    expect(message).toContain('只新增')
    expect(message).toContain(`doc_id=${String(first.doc_id)}`)
    expect(message).toContain('显式标题')
    expect(message).toContain(file!)
    expect(message).toContain('换一个标题')
    expect(message).toContain('.md')
    expect(rt.knowledge.detail(first.doc_id)?.chunks.map((c) => c.text).join('')).toContain('甲')
  })

  it('ingestUri keeps REPLACING the same identity when the caller confirms', async () => {
    openBoundary()
    const file = join(dir, 'uri.md')
    writeFileSync(file, '第一版：网关由平台组维护。')
    const first = (await rt.kb({ action: 'ingest', source_uri: file, domain: 'tech', source: 'uri.md' })) as { doc_id: number }
    writeFileSync(file, '第二版：网关由基础设施组维护。')
    const second = (await rt.kb({ action: 'ingest', source_uri: file, domain: 'tech', source: 'uri.md', overwrite: true })) as { doc_id: number }

    expect(second.doc_id).toBe(first.doc_id)
    const detail = (await rt.kb({ action: 'detail', doc_id: first.doc_id })) as { chunks: { text: string }[] }
    const body = detail.chunks.map((c) => c.text).join('')
    expect(body).toContain('基础设施组')
    expect(body).not.toContain('平台组')
  })

  it('importPaths keeps REPLACING a document with the same basename when the caller confirms', async () => {
    openBoundary()
    const src = join(dir, 'import-same')
    mkdirSync(src, { recursive: true })
    const file = join(src, 'same.md')
    writeFileSync(file, '第一版内容。')
    const first = (await rt.kb({ action: 'import', paths: [src], domain: 'tech', source: 'imp' })) as { imported: { doc_id: number }[] }
    writeFileSync(file, '第二版内容。')
    const second = (await rt.kb({ action: 'import', paths: [src], domain: 'tech', source: 'imp', overwrite: true })) as { imported: { doc_id: number }[] }

    expect(second.imported[0]!.doc_id).toBe(first.imported[0]!.doc_id)
    const detail = (await rt.kb({ action: 'detail', doc_id: first.imported[0]!.doc_id })) as { chunks: { text: string }[] }
    const body = detail.chunks.map((c) => c.text).join('')
    expect(body).toContain('第二版内容')
    expect(body).not.toContain('第一版内容')
  })

  it('sync re-ingests a stale managed file in place (replace by identity)', async () => {
    const { doc_id } = await rt.knowledge.ingest('原始正文。', 'tech', 'sync.md', '待同步')
    const file = rt.knowledge.docFilePath(doc_id)!
    writeFileSync(file, readFileSync(file, 'utf8').replace('原始正文。', '改过的正文。'))

    const applied = await rt.knowledge.sync()
    expect(applied.reingested).toBe(1)
    expect(rt.knowledge.detail(doc_id)?.chunks.map((c) => c.text).join('')).toContain('改过的正文')
  })
})

/**
 * The shared ingestion entry: **plan → classify → dispatch**, and its two modes.
 *
 * The plan stage is the part that has to be OBSERVABLE, not just claimed: a colliding `source_uri`
 * must answer with the collision even when the file could not be read (a binary the reader refuses)
 * or the URL could not be fetched (a loopback address the boundary refuses) — that is only possible
 * if the identity was resolved and looked up BEFORE any read or fetch.
 */
describe('shared ingestion entry: plan before read, and the two modes', () => {
  /** A PNG — a file `readLocalDocument` would refuse, so "conflict, not binary" is observable. */
  const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d])

  it('add mode refuses a colliding local file WITHOUT reading it (binary would be refused instead)', async () => {
    openBoundary()
    const dirPath = join(dir, 'plan-file')
    mkdirSync(dirPath, { recursive: true })
    const png = join(dirPath, 'shot.png')
    writeFileSync(png, PNG_BYTES)
    // Seed the identity directly: the title IS the file's basename, so no read is needed to collide.
    const seeded = await rt.knowledge.ingest('已有正文。', 'tech', 'plan', 'shot.png')

    const error = await rt.kbAdd({ source_uri: png, domain: 'tech', source: 'plan' })
      .then(() => null, (reason: unknown) => reason as Error)
    expect(error).toBeInstanceOf(Error)
    expect(error!.message).toContain('只新增')
    expect(error!.message).toContain(`doc_id=${String(seeded.doc_id)}`)
    // Title (the file's basename), managed path, and both ways out.
    expect(error!.message).toContain('shot.png')
    expect(error!.message).toContain(rt.knowledge.docFilePath(seeded.doc_id)!)
    expect(error!.message).toContain('换一个标题')
    expect(error!.message).toContain('.md')
    // If the plan had read the bytes, this would be the binary refusal, not the add-only refusal.
    expect(error!.message).not.toContain('PNG')
  })

  it('add mode refuses a colliding URL WITHOUT fetching it (loopback would be refused instead)', async () => {
    const uri = 'http://127.0.0.1:1/x'
    const seeded = await rt.knowledge.ingest('已有正文。', 'tech', 'plan-url', uri)

    const error = await rt.kbAdd({ source_uri: uri, domain: 'tech', source: 'plan-url' })
      .then(() => null, (reason: unknown) => reason as Error)
    expect(error).toBeInstanceOf(Error)
    expect(error!.message).toContain('只新增')
    expect(error!.message).toContain(`doc_id=${String(seeded.doc_id)}`)
    expect(error!.message).toContain(uri)
    expect(error!.message).toContain(rt.knowledge.docFilePath(seeded.doc_id)!)
    expect(error!.message).toContain('换一个标题')
    // The boundary refuses loopback BEFORE fetching, so a fetch attempt could never say "只新增".
    expect(error!.message).not.toContain('拒绝抓取')
    expect(error!.message).not.toContain('抓取失败')
  })

  it('replace mode reports a colliding file and writes nothing until confirmed', async () => {
    openBoundary()
    const file = join(dir, 'replace-file.md')
    writeFileSync(file, '第一版：平台组。')
    const first = (await rt.kb({ action: 'ingest', source_uri: file, domain: 'tech', source: 'rep' })) as { doc_id: number }

    writeFileSync(file, '第二版：基础设施组。')
    const report = (await rt.kb({ action: 'ingest', source_uri: file, domain: 'tech', source: 'rep' })) as KbConflictReport
    expect(report.conflict).toBe(true)
    expect(report.conflicts[0]!.doc_id).toBe(first.doc_id)
    expect(rt.knowledge.detail(first.doc_id)?.chunks.map((c) => c.text).join('')).toContain('平台组')

    const confirmed = (await rt.kb({ action: 'ingest', source_uri: file, domain: 'tech', source: 'rep', overwrite: true })) as { doc_id: number }
    expect(confirmed.doc_id).toBe(first.doc_id)
    const body = rt.knowledge.detail(first.doc_id)?.chunks.map((c) => c.text).join('') ?? ''
    expect(body).toContain('基础设施组')
    expect(body).not.toContain('平台组')
  })

  it('replace mode is all-or-nothing on a batch: every conflict blocks the whole import', async () => {
    openBoundary()
    const src = join(dir, 'replace-dir')
    mkdirSync(src, { recursive: true })
    writeFileSync(join(src, 'a.md'), 'a-v1')
    writeFileSync(join(src, 'b.md'), 'b-v1')
    const first = (await rt.kb({ action: 'import', paths: [src], domain: 'tech', source: 'rep-batch' })) as { imported: { doc_id: number }[] }
    const ids = new Map(first.imported.map((row) => [row.doc_id, row.doc_id]))
    expect(ids.size).toBe(2)

    writeFileSync(join(src, 'a.md'), 'a-v2')
    writeFileSync(join(src, 'b.md'), 'b-v2')
    const report = (await rt.kb({ action: 'import', paths: [src], domain: 'tech', source: 'rep-batch' })) as KbConflictReport
    expect(report.conflict).toBe(true)
    expect(report.would_overwrite).toBe(2)
    expect(report.would_add).toBe(0)
    // NOTHING was written, including the file that would have been a plain replace.
    for (const row of first.imported) {
      expect(rt.knowledge.detail(row.doc_id)?.chunks.map((c) => c.text).join('')).toContain('-v1')
    }

    const confirmed = (await rt.kb({ action: 'import', paths: [src], domain: 'tech', source: 'rep-batch', overwrite: true })) as { imported: { doc_id: number }[] }
    expect(confirmed.imported).toHaveLength(2)
    for (const row of first.imported) {
      expect(rt.knowledge.detail(row.doc_id)?.chunks.map((c) => c.text).join('')).toContain('-v2')
    }
  })

  it('add mode on a batch is per-file: existing ones go to `failed`, the rest still import', async () => {
    openBoundary()
    const src = join(dir, 'add-dir')
    mkdirSync(src, { recursive: true })
    writeFileSync(join(src, 'a.md'), 'a-v1')
    writeFileSync(join(src, 'b.md'), 'b-v1')
    const first = (await rt.kbAdd({ paths: [src], domain: 'tech', source: 'add-batch' })) as { imported: unknown[] }
    expect(first.imported).toHaveLength(2)

    // a.md is EDITED on disk: add mode must leave the indexed copy alone, not re-read it.
    writeFileSync(join(src, 'a.md'), 'a-v2')
    writeFileSync(join(src, 'c.md'), 'c-v1')
    const second = (await rt.kbAdd({ paths: [src], domain: 'tech', source: 'add-batch' })) as {
      imported: { doc_id: number }[]
      failed: { path: string; error: string }[]
    }
    expect(second.imported).toHaveLength(1)
    expect(second.failed).toHaveLength(2)
    for (const failure of second.failed) {
      expect(failure.error).toContain('只新增')
      expect(failure.error).toContain('doc_id=')
      expect(failure.error).toContain('.md')
    }
    expect(second.failed.map((failure) => failure.path.split('/').pop()).sort()).toEqual(['a.md', 'b.md'])

    const bodies = (await rt.kb({ action: 'list', domain: 'tech', source: 'add-batch' })) as { doc_id: number; title: string }[]
    const aId = bodies.find((row) => row.title === 'a.md')!.doc_id
    expect(rt.knowledge.detail(aId)?.chunks.map((c) => c.text).join('')).toContain('a-v1')
  })
})

/**
 * Incremental rebuild (DESIGN §20).
 *
 * Before this, the only way to know whether a chunk's derivations were up to date was to redo
 * them: a jieba pass and an ONNX forward pass per chunk over the whole corpus on every reindex.
 * The suite runs with the model disabled, which is also the case the report has to describe
 * honestly (`vectors_stale > vectors_encoded`).
 */
describe('reindex is incremental and can be planned', () => {
  /**
   * The knowledge database is a SEPARATE file (`rt.db` is the memory one), so the derived-state
   * assertions open it directly — the same pattern `memory.spec.ts` uses for the memory store.
   */
  let kbDb: Db
  beforeEach(() => {
    kbDb = openKnowledgeDb(rt.config.knowledge.db.path)
  })
  afterEach(() => {
    kbDb.close()
  })

  /** The identity the store writes into `doc_chunks.embedding_model` for the current config. */
  function currentSpace(): string {
    const cfg = rt.config.common.semantic
    return vectorSpaceId(cfg.backend, cfg.local_model, cfg.dim)
  }

  function chunkState(): { chunk_id: number; text: string; content_hash: string | null; embedding_model: string | null; entities_version: number | null }[] {
    return kbDb
      .prepare('SELECT chunk_id, text, content_hash, embedding_model, entities_version FROM doc_chunks ORDER BY chunk_id')
      .all() as never
  }

  it('records the derived state at ingest time', async () => {
    await rt.kb({ action: 'ingest', text: '平台组负责统一网关的维护与发布。', domain: 'tech', source: 'a.md' })
    const rows = chunkState()
    expect(rows.length).toBeGreaterThan(0)
    for (const row of rows) {
      expect(row.content_hash).toBe(contentHash(row.text))
      expect(row.entities_version).toBe(ENTITY_EXTRACTOR_VERSION)
    }
  })

  it('dry_run reports the plan and writes nothing', async () => {
    await rt.kb({ action: 'ingest', text: '平台组负责统一网关的维护与发布。', domain: 'tech', source: 'a.md' })
    // Simulate rows extracted by an older rule set (what the migration leaves behind).
    kbDb.prepare('UPDATE doc_chunks SET entities_version = NULL').run()

    const planned = (await rt.kb({ action: 'reindex', dry_run: true })) as {
      chunks: number; entities_rebuilt: number; vectors_stale: number; vectors_encoded: number; dry_run: boolean
    }
    expect(planned.dry_run).toBe(true)
    expect(planned.entities_rebuilt).toBe(0)
    expect(planned.vectors_encoded).toBe(0)
    expect(planned.vectors_stale).toBe(planned.chunks)
    // Nothing was written: the rows are still marked stale.
    expect(chunkState().every((r) => r.entities_version === null)).toBe(true)

    const real = (await rt.kb({ action: 'reindex' })) as { entities_rebuilt: number; chunks: number }
    expect(real.entities_rebuilt).toBe(real.chunks)
    expect(chunkState().every((r) => r.entities_version === ENTITY_EXTRACTOR_VERSION)).toBe(true)
  })

  it('reuses a vector only when its text AND its vector space still match', async () => {
    await rt.kb({ action: 'ingest', text: '平台组负责统一网关的维护与发布。', domain: 'tech', source: 'a.md' })
    const space = currentSpace()
    const vec = float32ToBytes(new Float32Array(rt.config.common.semantic.dim))
    const rows = chunkState()
    for (const row of rows) {
      kbDb
        .prepare('UPDATE doc_chunks SET semantic_vector = ?, embedding_model = ?, content_hash = ? WHERE chunk_id = ?')
        .run(vec, space, contentHash(row.text), row.chunk_id)
    }

    const upToDate = (await rt.kb({ action: 'reindex', dry_run: true })) as { vectors_stale: number }
    expect(upToDate.vectors_stale).toBe(0)

    // Same bytes, different model: the vectors are NOT comparable, so they must be redone.
    kbDb.prepare("UPDATE doc_chunks SET embedding_model = 'local_bge/other-model/512'").run()
    const foreign = (await rt.kb({ action: 'reindex', dry_run: true })) as { vectors_stale: number; chunks: number }
    expect(foreign.vectors_stale).toBe(foreign.chunks)

    // Back to the right space, but the text moved on: still stale.
    kbDb.prepare('UPDATE doc_chunks SET embedding_model = ?').run(space)
    kbDb.prepare("UPDATE doc_chunks SET content_hash = 'stale-hash'").run()
    const edited = (await rt.kb({ action: 'reindex', dry_run: true })) as { vectors_stale: number }
    expect(edited.vectors_stale).toBeGreaterThan(0)
  })

  it('notices a text edit that bypassed ingest — the case the digest exists for', async () => {
    // `ingest` replaces a document's chunks rather than editing their text, so a re-ingested
    // change arrives as a new row (no vector). The digest only fires for a mutation that skipped
    // that path — a hand-applied fix, or a future in-place edit. Pinned here because the claim
    // is otherwise untestable: nothing else in the codebase writes `doc_chunks.text`.
    await rt.kb({ action: 'ingest', text: '平台组负责统一网关的维护与发布。', domain: 'tech', source: 'a.md' })
    const space = currentSpace()
    const vec = float32ToBytes(new Float32Array(rt.config.common.semantic.dim))
    for (const row of chunkState()) {
      kbDb
        .prepare('UPDATE doc_chunks SET semantic_vector = ?, embedding_model = ? WHERE chunk_id = ?')
        .run(vec, space, row.chunk_id)
    }
    // Every row now looks derivable-from-current-state...
    expect(((await rt.kb({ action: 'reindex', dry_run: true })) as { vectors_stale: number }).vectors_stale).toBe(0)

    // ...until the text moves on without the hash following it.
    kbDb.prepare("UPDATE doc_chunks SET text = text || '补充说明。'").run()
    const edited = (await rt.kb({ action: 'reindex', dry_run: true })) as { vectors_stale: number; chunks: number }
    expect(edited.vectors_stale).toBe(edited.chunks)
  })

  it('says so when the embedder is down instead of reporting an empty plan', async () => {
    await rt.kb({ action: 'ingest', text: '平台组负责统一网关的维护与发布。', domain: 'tech', source: 'a.md' })
    const report = (await rt.kb({ action: 'reindex' })) as { semantic_available: boolean; vectors_stale: number; vectors_encoded: number }
    // The suite disables downloads, so the semantic leg is down by construction: the plan must
    // still show the outstanding work (not "0 to do"), and nothing may claim to be encoded.
    expect(report.semantic_available).toBe(false)
    expect(report.vectors_stale).toBeGreaterThan(0)
    expect(report.vectors_encoded).toBe(0)
  })
})

describe('cross-retrieval (memory + knowledge)', () => {
  it('blends memory facts and doc chunks with comparable scores', async () => {
    await rt.remember({ action: 'add', content: '张伟管理李娜' })
    await rt.kb({ action: 'ingest', text: '张伟负责支付网关的维护。', domain: 'tech', source: 'gw.md' })

    const res = await rt.query({ query: '张伟', limit: 10 })
    expect(res.hits.length).toBeGreaterThan(0)
    const kinds = new Set(res.hits.map((h) => h.kind))
    expect(kinds.has('fact')).toBe(true)
    expect(kinds.has('doc_chunk')).toBe(true)
    const factHit = res.hits.find((h) => h.kind === 'fact')
    const kbHit = res.hits.find((h) => h.kind === 'doc_chunk')
    expect(factHit?.source_ref).toMatch(/^memory:fact:/)
    expect(kbHit?.source_ref).toMatch(/^tech:gw\.md:/)
    // Both stores fill the hit's two timestamps — the fact's own row, the doc_chunk's owning
    // document — so a merged result never shows an empty time on one kind.
    for (const hit of res.hits) {
      expect(hit.created_at).toMatch(/^\d{4}-\d{2}-\d{2} /)
      expect(hit.updated_at).not.toBeNull()
    }
    for (const hit of res.hits) {
      expect(hit.score).toBeGreaterThanOrEqual(0)
      expect(hit.score).toBeLessThanOrEqual(1)
    }
  })

  it('filters by kind and does not mutate the stores\' own results', async () => {
    await rt.remember({ action: 'add', content: '王强负责风控引擎' })
    await rt.kb({ action: 'ingest', text: '风控引擎依赖规则库。', domain: 'tech', source: 'risk.md' })
    const memBefore = await rt.memory.search({ query: '风控' })
    const originalScores = memBefore.hits.map((x) => x.score)
    const onlyFacts = await rt.query({ query: '风控', kind: 'fact', limit: 10 })
    expect(onlyFacts.hits.every((h) => h.kind === 'fact')).toBe(true)
    expect(memBefore.hits.map((x) => x.score)).toEqual(originalScores)
  })

  it('source filter keeps only matching doc chunks', async () => {
    await rt.remember({ action: 'add', content: '张伟管理李娜' })
    await rt.kb({ action: 'ingest', text: '张伟负责支付网关的维护。', domain: 'tech', source: 'gw.md' })
    const res = await rt.query({ query: '张伟', source: 'gw.md', limit: 10 })
    expect(res.hits.length).toBeGreaterThan(0)
    for (const hit of res.hits) {
      expect(hit.kind).toBe('doc_chunk')
      expect(hit.source).toBe('gw.md')
    }
  })

  it('a domain filter drops memory hits and survives ":" in the domain/source', async () => {
    await rt.remember({ action: 'add', content: '张伟管理李娜' })
    await rt.kb({ action: 'ingest', text: '张伟负责支付网关的维护。', domain: 'a:b', source: 'spec:v1.md' })
    const kbOnly = await rt.query({ query: '张伟', domain: 'a:b', limit: 10 })
    expect(kbOnly.hits.length).toBeGreaterThan(0)
    expect(kbOnly.hits.every((h) => h.kind === 'doc_chunk')).toBe(true)
    const bySource = await rt.query({ query: '张伟', source: 'spec:v1.md', limit: 10 })
    expect(bySource.hits.length).toBeGreaterThan(0)
    expect(bySource.hits.every((h) => h.kind === 'doc_chunk' && h.source === 'spec:v1.md')).toBe(true)
  })
})

describe('ingestion boundary: file kind and size', () => {
  // The explicit timeout is part of the test, not slack: it spawns a child whose own kill deadline
  // is 20 s (below), and vitest's 5 s default would time the TEST out first — which it did,
  // intermittently, under a fully parallel suite. The assertion that matters is the child's
  // `timedOut` flag, so the outer bound must sit ABOVE the inner one.
  it.skipIf(process.platform === 'win32')('never blocks on a FIFO (bounded by a child-process kill deadline)', async () => {
    // A FIFO is not a directory and reports `size === 0`, so the old directory check and
    // the byte cap both let it through to a SYNCHRONOUS `readFileSync` that blocks until a
    // writer appears — freezing the whole host event loop, not just this call. It is
    // reachable as a direct `source_uri` and by walking an imported directory.
    openBoundary()
    const src = join(dir, 'import-src')
    mkdirSync(src, { recursive: true })
    writeFileSync(join(src, 'ok.md'), '平台组负责统一网关。')
    const alone = join(dir, 'alone.md')
    execFileSync('mkfifo', [alone])
    const walked = join(src, 'pipe.md')
    execFileSync('mkfifo', [walked])

    const res = await runFifoChild({ AVANTF_CHILD_HOME: dir, AVANTF_CHILD_FIFO: alone, AVANTF_CHILD_DIR: src }, 20_000)
    expect(res.timedOut, `child was killed — a FIFO read blocked the event loop\n${res.stderr.slice(-800)}`).toBe(false)
    expect(res.code, res.stderr.slice(-800)).toBe(0)

    const line = res.stdout.trim().split('\n').filter((l) => l.startsWith('{')).pop()
    const out = JSON.parse(line ?? '{}') as {
      ingestError: string
      imported: number
      failed: { file: string; error: string }[]
    }
    expect(out.ingestError).toMatch(/不是普通文件（FIFO/)
    // The walk still imports the real file and REPORTS the FIFO instead of reading it.
    expect(out.imported).toBe(1)
    expect(out.failed).toEqual([{ file: 'pipe.md', error: expect.stringMatching(/不是普通文件（FIFO/) }])
  }, 30_000)

  it('applies the byte cap to kb_import BEFORE materializing the file', async () => {
    openBoundary()
    const src = join(dir, 'import-big')
    mkdirSync(src, { recursive: true })
    const big = join(src, 'big.md')
    // Sparse: 80 MB+1 logically, no disk and no memory spent creating it.
    const fd = openSync(big, 'w')
    ftruncateSync(fd, OVER_CAP_BYTES)
    closeSync(fd)
    const res = (await rt.kb({ action: 'import', paths: [src], domain: 'tech', source: 'docs' })) as {
      imported: unknown[]
      failed: { path: string; error: string }[]
    }
    // `failed` — not a 80 MB read followed by a rejection.
    expect(res.imported).toHaveLength(0)
    expect(res.failed.map((f) => f.path)).toEqual([big])
    expect(res.failed[0]?.error).toMatch(/过大/)
    await expect(rt.kb({ action: 'ingest', source_uri: big, domain: 'tech', source: 'big' }))
      .rejects.toThrow(/过大/)
  })

  it('imports a ~/ path (the existence pre-check must expand ~ first)', async () => {
    openBoundary()
    const home = join(dir, 'home')
    mkdirSync(home, { recursive: true })
    writeFileSync(join(home, 'tilde.md'), '平台组负责统一网关的鉴权。')
    const saved = process.env['HOME']
    process.env['HOME'] = home
    try {
      // `existsSync('~/tilde.md')` is false (the raw string has no expansion), so the
      // pre-check used to throw "导入路径不存在" for a file that exists — the
      // very spelling the settings page's `如 ~/docs` placeholder advertises.
      const res = (await rt.kb({ action: 'import', paths: ['~/tilde.md'], domain: 'tech', source: 'docs' })) as {
        imported: { doc_id: number }[]
        failed: unknown[]
      }
      expect(res.imported).toHaveLength(1)
      expect(res.failed).toEqual([])
    } finally {
      if (saved === undefined) delete process.env['HOME']
      else process.env['HOME'] = saved
    }
  })
})

/**
 * A cross-store query encodes the query ONCE. Both legs share one backend and one model,
 * so each computing its own vector was the same 4 ms of work done twice — and with a
 * cross-encoder reranker, per-store reranking then paid for its own pass as well (that part
 * is by design, DESIGN §7: rerank belongs to each store's retriever).
 */
describe('cross-store query encodes the query once', () => {
  it('passes one pre-encoded vector to both legs', async () => {
    const DIM = 512
    let encodes = 0
    const vector = ((): Float32Array => { const v = new Float32Array(DIM); v[0] = 1; return v })()
    const counting: SemanticBackend = {
      name: 'counting_fake',
      dim: DIM,
      isAvailable: () => true,
      encode: async () => { encodes += 1; return vector },
      encodeBatch: async (texts) => texts.map(() => vector),
    }
    const rt2 = buildRuntime({ dataHome: dir, memoryDbPath: join(dir, 'memory.db'), semantic: counting })
    try {
      await rt2.remember({ action: 'add', content: '张伟管理李娜' })
      await rt2.kb({ action: 'ingest', text: '张伟负责支付网关。', domain: 'tech', source: 'gw.md' })
      // The writes above each encode their own content; only the QUERY is what we count.
      const before = encodes
      const res = await rt2.query({ query: '张伟', limit: 10 })
      expect(res.hits.length).toBeGreaterThan(0)
      expect(encodes - before).toBe(1)

      // A memory-only search still encodes its own query (no cross-store sharing to do).
      const beforeSearch = encodes
      await rt2.memory.search({ query: '张伟' })
      expect(encodes - beforeSearch).toBe(1)

      // …and a caller who already has the vector pays nothing.
      const beforeReuse = encodes
      await rt2.memory.search({ query: '张伟', queryVector: vector })
      await rt2.knowledge.search('张伟', { queryVector: vector })
      expect(encodes - beforeReuse).toBe(0)
    } finally {
      rt2.shutdown()
    }
  })
})

describe('injected vectors are checked for width', () => {
  const fake = (dim: number, available = true): SemanticBackend => ({
    name: `fake_${String(dim)}`,
    dim,
    isAvailable: () => available,
    encode: async () => new Float32Array(dim),
    encodeBatch: async (texts) => texts.map(() => new Float32Array(dim)),
  })

  it('buildRuntime refuses a semantic override whose dim differs from config.semantic.dim', () => {
    // The vector stores are built from `config.semantic.dim` (512 by default), so a narrower
    // backend would put mismatched vectors into them and only show up later as garbage scores.
    // The guard fires before the database is opened.
    expect(() => buildRuntime({ dataHome: dir, memoryDbPath: join(dir, 'memory.db'), semantic: fake(128) }))
      .toThrow(/语义覆盖维度 128 ≠ 配置里的 semantic\.dim 512/)
  })

  it('a store rejects a caller-supplied queryVector of the wrong width', async () => {
    const rt2 = buildRuntime({ dataHome: dir, memoryDbPath: join(dir, 'memory.db'), semantic: fake(512) })
    try {
      await expect(rt2.memory.search({ query: '张伟', queryVector: new Float32Array(8) }))
        .rejects.toThrow(/queryVector 维度不符：8 != 512/)
      await expect(rt2.knowledge.search('张伟', { queryVector: new Float32Array(8) }))
        .rejects.toThrow(/queryVector 维度不符：8 != 512/)
    } finally {
      rt2.shutdown()
    }
  })
})

describe('file ingestion: formats that used to be silent', () => {
  /** A directory the ingestion boundary may read (the temp data home is outside the workspace). */
  function workdir(): string {
    const sub = join(dir, 'incoming')
    mkdirSync(sub, { recursive: true })
    return sub
  }

  it('extracts a PDF text layer instead of indexing %PDF- syntax', async () => {
    openBoundary()
    const file = join(workdir(), 'spec.pdf')
    writeFileSync(file, tinyPdf('Gateway design spec v2', { compress: true }))

    const result = (await rt.kb({ action: 'ingest', source_uri: file, domain: 'tech', source: 'spec' })) as { doc_id: number }
    const detail = (await rt.kb({ action: 'detail', doc_id: result.doc_id })) as { chunks: { text: string }[] }
    const text = detail.chunks.map(chunk => chunk.text).join('')
    expect(text).toContain('Gateway design spec v2')
    expect(text).not.toContain('%PDF-')
  })

  it('fails loudly for a PDF with no text layer (scanned shape)', async () => {
    openBoundary()
    const file = join(workdir(), 'scan.pdf')
    writeFileSync(file, textlessPdf())
    await expect(rt.kb({ action: 'ingest', source_uri: file, domain: 'tech', source: 'scan' }))
      .rejects.toThrow(/没有可抽取的文本层/)
    expect((await rt.kb({ action: 'list' })) as unknown[]).toHaveLength(0)
  })

  it('converts a docx to Markdown, reports the converter, and the content is retrievable', async () => {
    openBoundary()
    const file = join(workdir(), 'gateway.docx')
    writeFileSync(file, docxBytes('网关设计规范', '限流策略采用令牌桶，突发流量按桶容量放行。'))

    const result = (await rt.kb({ action: 'ingest', source_uri: file, domain: 'tech', source: 'office' })) as {
      doc_id: number
      converter?: string
    }
    expect(result.converter).toBe('pandoc-3.11')

    const detail = (await rt.kb({ action: 'detail', doc_id: result.doc_id })) as { chunks: { text: string }[] }
    const text = detail.chunks.map(chunk => chunk.text).join('')
    expect(text).toContain('# 网关设计规范')
    expect(text).toContain('令牌桶')
    // End to end: the converted body is what the retrieval paths answer from.
    const hits = await rt.knowledge.search('令牌桶')
    expect(hits.length).toBeGreaterThan(0)
    expect(hits.some(hit => hit.text.includes('令牌桶'))).toBe(true)
  })

  it('still refuses a ZIP that is neither a docx nor an xlsx through the whole ingest path', async () => {
    openBoundary()
    const file = join(workdir(), 'archive.zip')
    writeFileSync(file, plainZipBytes())
    await expect(rt.kb({ action: 'ingest', source_uri: file, domain: 'tech', source: 'zip' }))
      .rejects.toThrow(/不支持的二进制文件（ZIP 压缩包/)
  })

  it('refuses an image passed as source_uri instead of indexing mojibake', async () => {
    openBoundary()
    const file = join(workdir(), 'shot.png')
    writeFileSync(file, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]))
    await expect(rt.kb({ action: 'ingest', source_uri: file, domain: 'tech', source: 'shot' }))
      .rejects.toThrow(/不支持的二进制文件/)
  })

  it('decodes a GBK .txt file instead of indexing mojibake (short files used to slip through)', async () => {
    openBoundary()
    const file = join(workdir(), 'legacy.txt')
    // GBK bytes for 「网关设计规范：平台组负责统一网关。」 — not valid UTF-8, and short enough that
    // the old "count replacement characters" rule never fired.
    writeFileSync(file, Buffer.from([
      0xcd, 0xf8, 0xb9, 0xd8, 0xc9, 0xe8, 0xbc, 0xc6, 0xb9, 0xe6, 0xb7, 0xb6, 0xa3, 0xba,
      0xc6, 0xbd, 0xcc, 0xa8, 0xd7, 0xe9, 0xb8, 0xba, 0xd4, 0xf0, 0xcd, 0xb3, 0xd2, 0xbb,
      0xcd, 0xf8, 0xb9, 0xd8, 0xa1, 0xa3,
    ]))

    const result = (await rt.kb({ action: 'ingest', source_uri: file, domain: 'tech', source: 'legacy' })) as {
      doc_id: number
      encoding?: string
    }
    expect(result.encoding).toBe('gb18030')
    const detail = (await rt.kb({ action: 'detail', doc_id: result.doc_id })) as { chunks: { text: string }[] }
    const text = detail.chunks.map(chunk => chunk.text).join('')
    expect(text).toContain('网关设计规范：平台组负责统一网关。')
    expect(text).not.toContain('\ufffd')
  })

  it('imports a directory: ingestable formats in, unreadable ones reported as skipped', async () => {
    openBoundary()
    const sub = workdir()
    writeFileSync(join(sub, 'doc.md'), '# 文档\n正文\n')
    writeFileSync(join(sub, 'paper.pdf'), tinyPdf('Paper abstract'))
    writeFileSync(join(sub, 'shot.png'), Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(16)]))
    writeFileSync(join(sub, 'data.csv'), 'a,b\n1,2\n')

    const result = (await rt.kb({ action: 'import', paths: [sub], domain: 'tech', source: 'dir' })) as {
      imported: unknown[]
      failed: unknown[]
      skipped: string[]
      skipped_total: number
    }
    // The table format joined the walk with the conversion feature; a plain zip would still be
    // skipped (it is not in the whitelist) and a PNG is skipped too.
    expect(result.imported).toHaveLength(3) // doc.md + paper.pdf + data.csv
    expect(result.failed).toEqual([])
    expect(result.skipped_total).toBe(1)
    expect(result.skipped.map(p => p.split('/').pop()).sort()).toEqual(['shot.png'])
    // The path reported is the walked one, so the operator can act on it.
    expect(result.skipped.every(p => p.startsWith(sub))).toBe(true)
  })

  it('takes an explicitly named file whatever its extension (only the directory walk filters)', async () => {
    openBoundary()
    const file = join(workdir(), 'table.csv')
    writeFileSync(file, 'name,qty\n网关,3\n')
    const result = (await rt.kb({ action: 'import', paths: [file], domain: 'tech', source: 'csv' })) as {
      imported: unknown[]
      skipped_total: number
    }
    expect(result.imported).toHaveLength(1)
    expect(result.skipped_total).toBe(0)
  })

  it('reports an explicitly named binary as failed, not skipped', async () => {
    openBoundary()
    const file = join(workdir(), 'shot2.png')
    writeFileSync(file, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(16)]))
    const result = (await rt.kb({ action: 'import', paths: [file], domain: 'tech', source: 'png' })) as {
      imported: unknown[]
      failed: { path: string; error: string }[]
    }
    expect(result.imported).toEqual([])
    expect(result.failed).toHaveLength(1)
    expect(result.failed[0]?.error).toMatch(/不支持的二进制文件/)
  })
})

/**
 * The vector shortfall must travel in the TOOL RESULT.
 *
 * `chunks` counts what was chunked, not what became semantically searchable. A skipped encode used to
 * be visible only in a log line, so the caller read "入库成功 N 段" as "N 段都能被语义检索到" and the
 * only way to find out otherwise was to run `kb_reindex` and compare `vectors_stale` with
 * `vectors_encoded`.
 */
describe('ingest reports the chunks that got no semantic vector', () => {
  const fake = (available: boolean): SemanticBackend => ({
    name: 'fake_ingest_report',
    dim: 512,
    isAvailable: () => available,
    encode: async () => new Float32Array(512),
    encodeBatch: async (texts) => texts.map(() => new Float32Array(512)),
  })

  function runtimeWith(available: boolean): { rt: AvantfRuntime; home: string } {
    const home = mkdtempSync(join(tmpdir(), 'avf-kb-vecreport-'))
    allowAnyDomain(home)
    const rt = buildRuntime({
      dataHome: home,
      memoryDbPath: join(home, 'memory.db'),
      semantic: fake(available),
    })
    return { rt, home }
  }

  it('counts every chunk when the embedding model is unavailable', async () => {
    const { rt, home } = runtimeWith(false)
    try {
      const res = await rt.knowledge.ingest('# 标题\n\n第一段正文，讲内存回收。\n\n第二段正文，讲页缓存。', 'notes')
      expect(res.chunks).toBeGreaterThan(0)
      expect(res.vectors_failed).toBe(res.chunks)
      // The text/entity/FTS indexes are still complete: the document is findable, just not semantically.
      const found = await rt.knowledge.search('内存回收')
      expect(Array.isArray(found)).toBe(true)
    } finally {
      rt.shutdown()
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('stays silent when every chunk was indexed', async () => {
    const { rt, home } = runtimeWith(true)
    try {
      const res = await rt.knowledge.ingest('# 标题\n\n第一段正文，讲内存回收。', 'notes')
      expect(res.chunks).toBeGreaterThan(0)
      expect(res.vectors_failed).toBeUndefined()
    } finally {
      rt.shutdown()
      rmSync(home, { recursive: true, force: true })
    }
  })
})
