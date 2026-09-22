/**
 * `kb_add`'s add-only contract, exercised through the real handler against a real runtime.
 *
 * `kb_add` used to carry its OWN collision pre-check, which derived the title as
 * `req.title ?? req.source` — the same fallback the store has since stopped using. Once the store
 * derives an untitled paste from its body, that pre-check would compare a different identity than
 * the one the store writes, so it was removed and the refusal moved to the store (`ingestNew`).
 * This spec pins the consequence where it matters: a colliding ADD is still refused, with document
 * identity the caller can act on.
 *
 * The handler lives in `src/dispatch.ts` — the ONE contract-key → runtime table, shared by the DSH
 * plugin and the MCP server — so this spec covers every surface that can call `kb_add`. Arguments go
 * through `KB_ADD_TOOL.input`, so the `source` default is applied exactly as the tool boundary
 * applies it.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildRuntime, kbAdd, type AvantfRuntime } from '../src/index.js'
import { KB_ADD_TOOL, type KbAddRequest } from '@avantf/mem-contract'

let dir: string
let rt: AvantfRuntime

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'avf-kbadd-'))
  mkdirSync(join(dir, 'configs'), { recursive: true })  // the config files live in one directory now
  rt = buildRuntime({ dataHome: dir })
})
afterEach(() => {
  rt.shutdown()
  rmSync(dir, { recursive: true, force: true })
})

/** The temp data home is outside the process workspace, so source_uri needs the boundary opened. */
function openBoundary(): void {
  mkdirSync(join(dir, 'knowledge'), { recursive: true })
  writeFileSync(join(dir, 'configs', 'knowledge.yaml'), 'domains: []\ningest:\n  allow_outside_workspace: true\n')
  rt.shutdown()
  rt = buildRuntime({ dataHome: dir })
}

/** What the dispatch table hands the handler: contract-parsed args (source defaulted to `default`). */
function call(args: Record<string, unknown>): Promise<unknown> {
  // `ToolSpec.input` is widened to `z.ZodType`, so `parse` reports `unknown` — the same cast every
  // surface makes after validating with a spec's schema.
  return kbAdd(rt, KB_ADD_TOOL.input.parse(args) as KbAddRequest)
}

/** The rejection a handler that delegates to the store produces. */
async function failure(args: Record<string, unknown>): Promise<Error> {
  const outcome = await call(args).then(() => null, (reason: unknown) => reason as Error)
  expect(outcome).toBeInstanceOf(Error)
  return outcome as Error
}

describe('kb_add', () => {
  it('refuses text whose explicit (domain, source, title) already exists', async () => {
    const first = (await call({ domain: 'notes', title: '冒烟文档', text: '第一篇正文。' })) as { doc_id: number }
    expect(first.doc_id).toBeGreaterThan(0)

    const error = await failure({ domain: 'notes', title: '冒烟文档', text: '第二篇正文。' })
    expect(error.message).toContain('只新增')
    expect(error.message).toContain(`doc_id=${String(first.doc_id)}`)
    // Still one document: the second call wrote nothing.
    expect(rt.knowledge.list('notes')).toHaveLength(1)
  })

  it('accepts two untitled pastes as two documents (the store derives distinct titles)', async () => {
    await call({ domain: 'notes', text: '第一篇：网关由平台组维护。' })
    const second = (await call({ domain: 'notes', text: '第二篇：日志走 ELK 栈。' })) as { doc_id: number }

    const rows = rt.knowledge.list('notes')
    expect(rows).toHaveLength(2)
    expect(rows.map((row) => row.title).sort()).toEqual(['第一篇：网关由平台组维护。', '第二篇：日志走 ELK 栈。'].sort())
    expect(rows.some((row) => row.doc_id === second.doc_id)).toBe(true)
  })

  it('refuses a second paste with the same derived title, naming the file to edit', async () => {
    const first = (await call({ domain: 'notes', text: '同一标题\n\n正文甲。' })) as { doc_id: number; file?: string }
    const error = await failure({ domain: 'notes', text: '同一标题\n\n正文乙。' })

    expect(error.message).toContain(`doc_id=${String(first.doc_id)}`)
    expect(error.message).toContain('同一标题')
    expect(error.message).toContain(String(first.file))
    expect(error.message).toContain('.md')
  })

  it('still rejects a call that gives none of text / source_uri / paths', async () => {
    const result = (await call({ domain: 'notes' })) as { error?: string }
    expect(result.error).toContain('三者之一')
  })

  it('refuses a colliding local file (source_uri), naming the document and its managed path', async () => {
    openBoundary()
    const file = join(dir, 'kb-add-local.md')
    writeFileSync(file, '第一版正文。')
    const first = (await call({ domain: 'notes', source: 'local', source_uri: file })) as { doc_id: number; file?: string }

    const error = await failure({ domain: 'notes', source: 'local', source_uri: file })
    expect(error.message).toContain('只新增')
    expect(error.message).toContain(`doc_id=${String(first.doc_id)}`)
    expect(error.message).toContain(String(first.file))
    expect(error.message).toContain('换一个标题')
    // Nothing replaced: the document body is still the first version.
    expect(rt.knowledge.list('notes')).toHaveLength(1)
  })

  it('refuses a colliding URL (source_uri) without fetching it', async () => {
    // Seed the URL identity directly: no fetch is needed to know it collides.
    const uri = 'http://127.0.0.1:1/x'
    const seeded = await rt.knowledge.ingest('已有正文。', 'notes', 'url', uri)

    const error = await failure({ domain: 'notes', source: 'url', source_uri: uri })
    expect(error.message).toContain('只新增')
    expect(error.message).toContain(`doc_id=${String(seeded.doc_id)}`)
    expect(error.message).toContain(uri)
    expect(error.message).toContain('换一个标题')
    // A fetch would have been refused as loopback, which could never produce this message.
    expect(error.message).not.toContain('拒绝抓取')
    expect(error.message).not.toContain('抓取失败')
  })

  it('adds a local file when its identity is free, then rejects only that one in a batch', async () => {
    openBoundary()
    const src = join(dir, 'kb-add-batch')
    mkdirSync(src, { recursive: true })
    writeFileSync(join(src, 'a.md'), 'a-v1')
    const first = (await call({ domain: 'notes', source: 'batch', paths: [src] })) as { imported: unknown[] }
    expect(first.imported).toHaveLength(1)

    writeFileSync(join(src, 'b.md'), 'b-v1')
    const second = (await call({ domain: 'notes', source: 'batch', paths: [src] })) as {
      imported: unknown[]
      failed: { path: string; error: string }[]
    }
    // The existing a.md is reported (not rewritten); the new b.md still lands.
    expect(second.imported).toHaveLength(1)
    expect(second.failed).toHaveLength(1)
    expect(second.failed[0]!.error).toContain('只新增')
    expect(second.failed[0]!.error).toContain('doc_id=')
    expect(second.failed[0]!.error).toContain('换一个标题')
    expect(second.failed[0]!.path.split('/').pop()).toBe('a.md')
    expect(rt.knowledge.list('notes', 'batch')).toHaveLength(2)
  })

  it('adds a fresh source_uri normally', async () => {
    openBoundary()
    const file = join(dir, 'kb-add-fresh.md')
    writeFileSync(file, '新文档正文。')
    const result = (await call({ domain: 'notes', source: 'fresh', source_uri: file })) as { doc_id: number; chunks: number }
    expect(result.doc_id).toBeGreaterThan(0)
    expect(result.chunks).toBeGreaterThan(0)
  })
})
