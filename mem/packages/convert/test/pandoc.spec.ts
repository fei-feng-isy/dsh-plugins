/**
 * A REAL `.docx` through the real pandoc: the acceptance this whole change exists for.
 *
 * The document is written by pandoc itself (`-t docx`), so it is a genuine WordprocessingML package
 * — styles, content types, relationships, numbering — rather than the hand-built minimal ZIP the
 * other specs use. Reading it back proves the reader path a user's document takes, and the
 * assertions are on the STRUCTURE (heading levels → ATX headings, a Word table → a GFM table), which
 * is what the chunker and the retriever depend on.
 *
 * Skipped when pandoc is not installed (see `describe.skipIf`), like `git.spec.ts`'s `hasGit`: the
 * binary is normally provisioned at plugin mount, and the mechanism itself is covered by the
 * provision package's local-fixture specs.
 */
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { convertToMarkdown, pandocAvailable, resetPandocResolution, setPandocProvisioning } from '../src/index.js'

/** The pinned release this project provisions (`@avantf/mem-provision`), used as the docx WRITER too. */
const PANDOC = process.env['AVANTF_PANDOC']
  ?? join(process.env['AVANTF_HOME']?.trim() || join(process.env['HOME'] ?? '', '.avantf', 'env'), 'tools', 'pandoc', '3.11', 'bin', 'pandoc')

const hasPandoc = pandocAvailable().ok && existsSync(PANDOC)

/** A Markdown source exercising heading levels, emphasis, a list and a table. */
const SOURCE = [
  '# 网关设计规范',
  '',
  '## 限流策略',
  '',
  '网关对**每个租户**按令牌桶限流，默认 100 QPS，突发 200 QPS。',
  '',
  '- 令牌桶按租户维度隔离',
  '- 超限返回 429 并带 Retry-After',
  '',
  '## 组件职责',
  '',
  '| 组件 | 职责 |',
  '| --- | --- |',
  '| 路由 | 按路径前缀转发到上游服务 |',
  '| 鉴权 | 校验 JWT 并注入租户标识 |',
  '',
].join('\n')

describe.skipIf(!hasPandoc)('a real .docx through pandoc', () => {
  let work: string
  let docx: string

  beforeAll(() => {
    work = mkdtempSync(join(process.cwd(), '.convert-docx-'))
    const source = join(work, 'source.md')
    docx = join(work, '网关设计规范.docx')
    writeFileSync(source, SOURCE, 'utf8')
    execFileSync(PANDOC, ['-f', 'markdown', '-t', 'docx', '-o', docx, source], { stdio: 'pipe' })
  })

  afterAll(() => {
    resetPandocResolution()
    rmSync(work, { recursive: true, force: true })
  })

  it('converts to GFM with the heading hierarchy, the table and the emphasis intact', async () => {
    const result = await convertToMarkdown({ bytes: readFileSync(docx), path: docx })
    expect(result?.converter).toBe('pandoc-3.11')
    expect(result?.markdown).toContain('# 网关设计规范')
    expect(result?.markdown).toContain('## 限流策略')
    expect(result?.markdown).toContain('## 组件职责')
    expect(result?.markdown).toContain('**每个租户**')
    expect(result?.markdown).toContain('令牌桶按租户维度隔离')
    // A GFM table, not a flattened run-on paragraph.
    expect(result?.markdown).toMatch(/\|\s*组件\s*\|\s*职责\s*\|/)
    expect(result?.markdown).toMatch(/\|\s*-+\s*\|\s*-+\s*\|/)
    expect(result?.markdown).toContain('路由')
  })

  it('records the converter it used in the result (visible cross-machine)', async () => {
    const result = await convertToMarkdown({ bytes: readFileSync(docx), path: 'renamed.txt' })
    // The reader comes from the archive entries, not the extension, so the wrong name still works.
    expect(result?.converter).toMatch(/^pandoc-\d+\.\d+/)
  })

  it('runs the same conversion twice with identical output (determinism)', async () => {
    const first = await convertToMarkdown({ bytes: readFileSync(docx), path: docx })
    const second = await convertToMarkdown({ bytes: readFileSync(docx), path: docx })
    expect(second?.markdown).toBe(first?.markdown)
  })

  it('refuses a legacy .doc by name rather than decoding it as text', async () => {
    const ole = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0x00, 0x00])
    await expect(convertToMarkdown({ bytes: ole, path: 'old.doc' })).rejects.toThrow(/OLE/)
  })

  it('uses an explicit AVANTF_PANDOC path without consulting the managed directory', async () => {
    const previous = process.env['AVANTF_PANDOC']
    process.env['AVANTF_PANDOC'] = PANDOC
    resetPandocResolution()
    try {
      setPandocProvisioning({ toolsDir: join(work, 'no-such-tools'), mirror: [], autoInstall: false })
      const result = await convertToMarkdown({ bytes: readFileSync(docx), path: docx })
      expect(result?.converter).toBe('pandoc-3.11')
    } finally {
      if (previous === undefined) delete process.env['AVANTF_PANDOC']
      else process.env['AVANTF_PANDOC'] = previous
      resetPandocResolution()
    }
  })
})

describe('pandoc availability (no conversion)', () => {
  it('answers a capability question without installing anything', () => {
    const available = pandocAvailable()
    if (available.ok) {
      expect(available.source).toMatch(/^(explicit|managed|system)$/)
      expect(available.path).toContain('pandoc')
    } else {
      // The failure must be actionable: which sources were tried, and how to fix it per platform.
      expect(available.reason.length).toBeGreaterThan(0)
    }
  })
})
