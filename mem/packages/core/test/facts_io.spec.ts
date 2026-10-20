/**
 * The encoding layer of the facts export, without a database.
 *
 * WHAT MATTERS HERE. The document format did not change (`version` stays 1) — only the bytes on
 * disk may be gzip or brotli now. So the two properties this spec pins are (a) every container
 * round-trips to the SAME document, and (b) decoding is by CONTENT, not by file name: a brotli file
 * renamed to `.json` must still import, every pre-compression pretty file must still import, and a
 * genuinely broken file must fail with the three accepted forms named.
 */
import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  codecForExportPath,
  decodeFactsExport,
  encodeFactsExport,
  parseFactsExport,
  serializeFactsExport,
  type FactsExportDocument,
} from '../src/facts_io.js'

function sampleDoc(): FactsExportDocument {
  return {
    format: 'avantf-mem-facts',
    version: 1,
    exported_at: '2026-10-20T06:45:00.000Z',
    source: {
      data_home: '/home/user/.avantf',
      db: '/home/user/.avantf/memory/memory.db',
      counts: { active: 1, archived: 1 },
    },
    facts: [
      {
        source_id: 1,
        content: '用户偏好把备份写成压缩文件',
        category: 'project',
        status: 'active',
        created_at: '2026-10-01T01:00:00.000Z',
        updated_at: '2026-10-02T02:00:00.000Z',
        ttl_days: 30,
        pinned: false,
        pinned_at: null,
        trust_score: 0.5,
        assert_count: 1,
        helpful_count: 0,
        last_reinforced_at: null,
        sources: [{ kind: 'manual', ref: 'tool:laptop' }],
        valid_from: '2026-09-01',
        valid_to: null,
        supersedes_source_id: null,
        archive: null,
      },
      {
        source_id: 2,
        content: '这条事实已被归档',
        category: 'general',
        status: 'archived',
        created_at: '2026-09-01T01:00:00.000Z',
        updated_at: '2026-09-02T02:00:00.000Z',
        ttl_days: 0,
        pinned: true,
        pinned_at: '2026-09-03T00:00:00.000Z',
        trust_score: 0.9,
        assert_count: 3,
        helpful_count: 2,
        last_reinforced_at: '2026-09-04T00:00:00.000Z',
        sources: [],
        valid_from: null,
        valid_to: '2026-12-31',
        supersedes_source_id: 7,
        archive: { at: '2026-09-05T00:00:00.000Z', reason: 'superseded' },
      },
    ],
  }
}

describe('facts export serialization', () => {
  it('is MINIFIED by default; pretty is debug-only and keeps the trailing newline', () => {
    const doc = sampleDoc()
    const minified = serializeFactsExport(doc)

    expect(minified).toBe(JSON.stringify(doc))
    expect(minified).not.toContain('\n')
    expect(minified).not.toContain('  ')
    // The text entry point parses either form, so stdin stays compatible both ways.
    expect(parseFactsExport(minified)).toEqual(doc)

    const pretty = serializeFactsExport(doc, { pretty: true })
    expect(pretty).toBe(JSON.stringify(doc, null, 2) + '\n')
    expect(pretty).toContain('\n  "format"')
    expect(parseFactsExport(pretty)).toEqual(doc)
  })

  it('round-trips all three codecs to the SAME document', () => {
    const doc = sampleDoc()
    for (const codec of ['none', 'gzip', 'brotli'] as const) {
      const bytes = encodeFactsExport(doc, { codec })
      const decoded = decodeFactsExport(bytes)
      expect(decoded.codec, codec).toBe(codec)
      expect(decoded.doc, codec).toEqual(doc)
    }
    // 'none' is exactly the minified text, and gzip really has the magic header.
    expect(encodeFactsExport(doc, { codec: 'none' }).toString('utf8')).toBe(serializeFactsExport(doc))
    const gzip = encodeFactsExport(doc, { codec: 'gzip' })
    expect([gzip[0], gzip[1]]).toEqual([0x1f, 0x8b])
  })

  it('detects the container by CONTENT: a compressed file named .json still imports', () => {
    const doc = sampleDoc()
    const dir = mkdtempSync(join(tmpdir(), 'avf-facts-io-'))
    try {
      for (const codec of ['gzip', 'brotli'] as const) {
        const file = join(dir, codec + '-but-named.json')
        writeFileSync(file, encodeFactsExport(doc, { codec }))
        const decoded = decodeFactsExport(readFileSync(file))
        expect(decoded.codec, codec).toBe(codec)
        expect(decoded.doc, codec).toEqual(doc)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('imports the OLD pretty JSON form (the whole pre-compression corpus)', () => {
    const doc = sampleDoc()
    const decoded = decodeFactsExport(Buffer.from(serializeFactsExport(doc, { pretty: true }), 'utf8'))
    expect(decoded.codec).toBe('none')
    expect(decoded.doc).toEqual(doc)
  })

  it('refuses corrupt bytes with the three accepted forms named', () => {
    const corrupt = Buffer.from([0x00, 0x01, 0x02, 0xff, 0xfe, 0x7b, 0x22])
    let message = ''
    try {
      decodeFactsExport(corrupt)
    } catch (error) {
      message = error instanceof Error ? error.message : String(error)
    }
    expect(message).toContain('.json')
    expect(message).toContain('.json.gz')
    expect(message).toContain('.json.br')
    expect(message).toContain('按内容识别')
  })

  it('treats a gzip magic header as decisive: corrupt gzip is reported as gzip', () => {
    const bytes = Buffer.concat([Buffer.from([0x1f, 0x8b]), Buffer.from('this is not a gzip stream')])
    expect(() => decodeFactsExport(bytes)).toThrow(/gzip 解压失败/)
  })

  it('never masks a wrong format / version behind the brotli fallback', () => {
    const wrongFormat = Buffer.from(JSON.stringify({ format: 'something-else', version: 1, facts: [] }))
    expect(() => decodeFactsExport(wrongFormat)).toThrow(/format/)
    const wrongVersion = Buffer.from(JSON.stringify({ format: 'avantf-mem-facts', version: 2, facts: [] }))
    expect(() => decodeFactsExport(wrongVersion)).toThrow(/不支持的导出格式版本/)
  })

  it('resolves a file codec: flag → extension → plain', () => {
    expect(codecForExportPath('/backups/memory.json.br')).toBe('brotli')
    expect(codecForExportPath('/backups/memory.json.gz')).toBe('gzip')
    expect(codecForExportPath('/backups/memory.json')).toBe('none')
    expect(codecForExportPath('/backups/MEMORY.JSON.BR')).toBe('brotli')
    expect(codecForExportPath('/backups/memory.json.br', 'none')).toBe('none')
    expect(codecForExportPath('/backups/memory.json', 'gzip')).toBe('gzip')
  })
})
