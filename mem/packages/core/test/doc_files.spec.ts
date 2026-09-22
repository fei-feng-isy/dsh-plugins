/**
 * Managed document files: the editable copy behind `knowledge.docs.dir`.
 *
 * What is worth pinning here is the CONTRACT between the file and the index, because getting it
 * wrong is silent in both directions: a file that drifts from the index keeps answering queries
 * with stale text, and a file that is mistaken for another document's makes 「删除」 remove the
 * wrong thing. So each case below checks both the file system and what the store believes.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { buildRuntime, type AvantfRuntime } from '../src/runtime.js'
import { bodyHash, deriveDocTitle, parseDocFile, renderDocFile, sanitizeSegment } from '../src/store/doc_files.js'

let dir: string
let rt: AvantfRuntime

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'avantf-docfiles-'))
  rt = buildRuntime({ dataHome: dir })
})

afterEach(() => {
  rt.shutdown()
  rmSync(dir, { recursive: true, force: true })
})

/** The managed path of one document, read the same way the host resolves it. */
function pathOf(docId: number): string {
  const path = rt.knowledge.docFilePath(docId)
  if (path === null) throw new Error(`no managed path for #${String(docId)}`)
  return path
}

/** Rewrite a managed file's body, keeping its frontmatter — what an editor would leave behind. */
function editBody(path: string, body: string): void {
  const text = readFileSync(path, 'utf8')
  const parsed = parseDocFile(text)
  const header = text.slice(0, text.length - parsed.body.length)
  writeFileSync(path, `${header}${body}\n`, 'utf8')
}

describe('managed document files', () => {
  it('materializes one file per ingest, with the identity the database uses', async () => {
    const result = await rt.knowledge.ingest('# 标题\n\n正文内容', 'design', 'spec', '检索设计')
    const path = pathOf(result.doc_id)

    expect(result.file).toBe(path)
    expect(existsSync(path)).toBe(true)
    expect(path.endsWith(join('design', 'spec', '检索设计.md'))).toBe(true)

    const parsed = parseDocFile(readFileSync(path, 'utf8'))
    expect(parsed.meta.doc_id).toBe(result.doc_id)
    expect(parsed.meta.domain).toBe('design')
    expect(parsed.meta.source).toBe('spec')
    expect(parsed.meta.title).toBe('检索设计')
    expect(parsed.meta.content_hash).toBe(bodyHash(parsed.body))
    expect(parsed.body).toContain('正文内容')
  })

  it('re-ingest reuses the same file and refreshes the recorded hash', async () => {
    const first = await rt.knowledge.ingest('第一版', 'design', 'spec', '同名文档')
    const second = await rt.knowledge.ingest('第二版', 'design', 'spec', '同名文档')

    expect(second.doc_id).toBe(first.doc_id) // identity is domain/source/title
    expect(second.file).toBe(first.file)
    const parsed = parseDocFile(readFileSync(pathOf(second.doc_id), 'utf8'))
    expect(parsed.body).toContain('第二版')
    expect(parsed.meta.content_hash).toBe(bodyHash(parsed.body))
    await expect(rt.knowledge.sync({ dryRun: true })).resolves.toMatchObject({ stale: [], missing: [] })
  })

  it('reports a file as fresh, then stale once its body is edited, then fresh again after sync', async () => {
    const { doc_id } = await rt.knowledge.ingest('原始内容', 'design', 'spec', '会改的文档')
    const path = pathOf(doc_id)

    await expect(rt.knowledge.sync({ dryRun: true })).resolves.toMatchObject({ stale: [], missing: [] })

    editBody(path, '改过的内容')
    const dry = await rt.knowledge.sync({ dryRun: true })
    expect(dry.stale.map(file => file.doc_id)).toEqual([doc_id])
    expect(dry.reingested).toBe(0)

    const applied = await rt.knowledge.sync()
    expect(applied.reingested).toBe(1)
    // The edit reached the index, under the SAME doc_id.
    const chunks = rt.knowledge.detail(doc_id)?.chunks.map(chunk => chunk.text).join('') ?? ''
    expect(chunks).toContain('改过的内容')
    expect(chunks).not.toContain('原始内容')
    expect((await rt.knowledge.sync({ dryRun: true })).stale).toEqual([])
  })

  it('reports a missing file without touching the indexed copy', async () => {
    const { doc_id } = await rt.knowledge.ingest('文件被删的内容', 'design', 'spec', '手工删文件')
    rmSync(pathOf(doc_id))

    const report = await rt.knowledge.sync({ dryRun: true })
    expect(report.missing.map(file => file.doc_id)).toEqual([doc_id])
    // The document is still there and still searchable: losing the copy is not losing the doc.
    expect(rt.knowledge.detail(doc_id)).not.toBeNull()
  })

  it('remove deletes the managed file along with the document', async () => {
    const { doc_id } = await rt.knowledge.ingest('待删除', 'design', 'spec', '删除我')
    const path = pathOf(doc_id)

    expect(rt.knowledge.remove(doc_id)).toBe(true)
    expect(existsSync(path)).toBe(false)
    expect(rt.knowledge.detail(doc_id)).toBeNull()
    expect(rt.knowledge.remove(doc_id)).toBe(false) // idempotent: nothing left to delete
  })

  it('reports files no document claims as orphans', async () => {
    await rt.knowledge.ingest('在册文档', 'design', 'spec', '在册')
    const stray = join(dir, 'knowledge', 'docs', 'design', 'spec', '无主.md')
    writeFileSync(stray, '---\ndoc_id: 9999\n---\n没人认领\n', 'utf8')

    const report = await rt.knowledge.sync({ dryRun: true })
    expect(report.orphans).toEqual(['design/spec/无主.md'])
  })

  it('does not double the .md extension for a title that is already a file name', async () => {
    // `kb ingest --uri notes.md` names the document after the file it read.
    const { doc_id } = await rt.knowledge.ingest('内容', 'design', 'spec', 'notes.md')
    expect(pathOf(doc_id).endsWith(join('design', 'spec', 'notes.md'))).toBe(true)
  })

  it('keeps colliding titles in separate files instead of overwriting each other', async () => {
    // Same sanitized name, different identities: '/' and ':' both flatten to '-'.
    const a = await rt.knowledge.ingest('A 的内容', 'design', 'spec', 'a/b')
    const b = await rt.knowledge.ingest('B 的内容', 'design', 'spec', 'a:b')

    expect(a.file).not.toBe(b.file)
    expect(parseDocFile(readFileSync(pathOf(a.doc_id), 'utf8')).body).toContain('A 的内容')
    expect(parseDocFile(readFileSync(pathOf(b.doc_id), 'utf8')).body).toContain('B 的内容')
    // Both are stable: resolving the path again lands on the same file for each.
    expect(pathOf(a.doc_id)).toBe(a.file)
    expect(pathOf(b.doc_id)).toBe(b.file)
  })

  it('never lets a title escape the managed directory', async () => {
    const { doc_id } = await rt.knowledge.ingest('逃逸尝试', 'design', 'spec', '../../etc/passwd')
    const root = join(dir, 'knowledge', 'docs')
    const path = pathOf(doc_id)

    expect(path.startsWith(root)).toBe(true)
    // The property that matters is that no `.` / `..` survives as its own path SEGMENT: a `..`
    // inside a file name (`-..-etc-passwd.md`) is inert, one as a segment is a traversal.
    const segments = relative(root, path).split(sep)
    expect(segments).not.toContain('..')
    expect(segments).not.toContain('.')
    expect(existsSync(path)).toBe(true)
  })

  it('records the converter in frontmatter, and an edit + sync does not erase it', async () => {
    const result = await rt.knowledge.ingest(
      '# 标题\n\n正文', 'design', 'spec', '转换来的文档', undefined, undefined, 'ingest', 'docx', ['图片未转换'],
    )
    const path = pathOf(result.doc_id)
    const parsed = parseDocFile(readFileSync(path, 'utf8'))
    expect(parsed.meta.converter).toBe('docx')
    expect(parsed.body).toBe('# 标题\n\n正文')

    editBody(path, '改过的正文')
    await rt.knowledge.sync({ docId: result.doc_id })
    const after = parseDocFile(readFileSync(path, 'utf8'))
    expect(after.meta.converter).toBe('docx')
    expect(after.body).toBe('改过的正文\n')
    expect(after.meta.content_hash).toBe(bodyHash(after.body))
  })

  it('omits the converter for a document that was not converted, and old files still parse', () => {
    const meta = {
      doc_id: 1,
      domain: 'design',
      source: 'spec',
      title: '纯文本',
      source_uri: null,
      ingested_at: '2024-01-01T00:00:00.000Z',
      content_hash: 'hash',
    }
    // No `converter:` line at all for a text document — the shape every file written before this
    // field existed has, so reading it must not depend on the field being present.
    const text = renderDocFile(meta, '正文')
    expect(text).not.toContain('converter')
    expect(parseDocFile(text).meta).toEqual(meta)
    expect(parseDocFile(renderDocFile({ ...meta, converter: 'xlsx' }, '正文')).meta.converter).toBe('xlsx')
  })

  it('sanitizes segments without losing a readable name', () => {
    expect(sanitizeSegment('检索 设计', 'x')).toBe('检索 设计')
    expect(sanitizeSegment('a/b:c*d?', 'x')).toBe('a-b-c-d-')
    expect(sanitizeSegment('   ', 'fallback')).toBe('fallback')
    expect(sanitizeSegment('...', 'fallback')).toBe('fallback')
    expect(sanitizeSegment('x'.repeat(200), 'fallback')).toHaveLength(80)
    // Windows device names stay reserved WITH an extension (`CON.md` is the console), so a document
    // titled "con" would make its managed copy impossible to write.
    expect(sanitizeSegment('CON', 'x')).toBe('_CON')
    expect(sanitizeSegment('aux', 'x')).toBe('_aux')
    expect(sanitizeSegment('COM1', 'x')).toBe('_COM1')
    expect(sanitizeSegment('lpt9', 'x')).toBe('_lpt9')
    // …but only the device names themselves, not words that merely contain them.
    expect(sanitizeSegment('console', 'x')).toBe('console')
    expect(sanitizeSegment('COM10', 'x')).toBe('COM10')
  })
})

describe('deriveDocTitle (the default title for pasted text)', () => {
  it('prefers the first ATX heading, even when plain lines come before it', () => {
    expect(deriveDocTitle('一句引言。\n\n## 真正的标题\n\n正文')).toBe('真正的标题')
    expect(deriveDocTitle('# 一级\n## 二级')).toBe('一级') // the FIRST heading wins
  })

  it('never mistakes fenced code for a heading', () => {
    expect(deriveDocTitle('```c\n#include <stdio.h>\n```\n\n# 真标题\n\n正文')).toBe('真标题')
    // With no heading at all, the first line OUTSIDE the fence is the fallback, not the `#include`.
    expect(deriveDocTitle('```\n#include <stdio.h>\n```\n正文行')).toBe('正文行')
  })

  it('strips block markers from the first non-empty line when there is no heading', () => {
    expect(deriveDocTitle('\n\n- 第一项\n- 第二项')).toBe('第一项')
    expect(deriveDocTitle('> 引用行')).toBe('引用行')
    expect(deriveDocTitle('1. 有序项')).toBe('有序项')
    expect(deriveDocTitle('2) 另一种有序项')).toBe('另一种有序项')
    // `#include` is not an ATX heading (no space), so it falls through to the stripped first line.
    expect(deriveDocTitle('#include <stdio.h>\n正文')).toBe('include <stdio.h>')
  })

  it('caps the title at the same limit the managed file name uses', () => {
    expect(deriveDocTitle('x'.repeat(200))).toHaveLength(80)
    expect(deriveDocTitle('# 标题' + 'y'.repeat(200))).toHaveLength(80)
  })

  it('falls back to `untitled` for a body with nothing to read', () => {
    expect(deriveDocTitle('')).toBe('untitled')
    expect(deriveDocTitle('   \n\t\n  ')).toBe('untitled')
  })

  it('is deterministic: the same body always yields the same title', () => {
    const body = '# 幂等\n\n同一段文本。'
    expect(deriveDocTitle(body)).toBe(deriveDocTitle(body))
    expect(deriveDocTitle('无标题首行\n第二行')).toBe(deriveDocTitle('无标题首行\n第二行'))
  })
})
