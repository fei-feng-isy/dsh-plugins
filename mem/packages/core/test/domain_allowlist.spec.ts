/**
 * The write-side knowledge-domain guard and the `source` default.
 *
 * The picker in the 知识 tab is not a guard: agent tools, the CLI and MCP all write through the
 * store, so the refusal lives here. The allowlist is `knowledge.domains` (empty = no restriction)
 * UNION the domains the library already holds — the union is what keeps a taxonomy written before
 * the allowlist existed usable.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { KbUnion } from '@avantf/mem-contract'
import { buildRuntime, type AvantfRuntime } from '../src/index.js'

let dir: string
let rt: AvantfRuntime | undefined

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'avf-domains-'))
  mkdirSync(join(dir, 'configs'), { recursive: true })  // the config files live in one directory now
  rt = undefined
})
afterEach(() => { rt?.shutdown(); rmSync(dir, { recursive: true, force: true }) })

/** Boot a runtime whose store config is exactly `yaml` (or nothing, to get the shipped default). */
function boot(yaml?: string): AvantfRuntime {
  if (yaml !== undefined) {
    mkdirSync(join(dir, 'knowledge'), { recursive: true })
    writeFileSync(join(dir, 'configs', 'knowledge.yaml'), yaml)
  }
  rt?.shutdown()
  rt = buildRuntime({ dataHome: dir })
  return rt
}

describe('knowledge.domains write-side allowlist', () => {
  it('refuses a new domain outside the allowlist, naming every allowed value', async () => {
    const r = boot('domains:\n  - design\n  - ops\n')
    await expect(r.knowledge.ingest('正文', 'Android', '总结文档'))
      .rejects.toThrow(/知识域「Android」不在允许清单里：design、ops/)
    // The refusal is by value, not by "looks unusual": another unlisted name is refused too.
    await expect(r.knowledge.ingest('正文', '设计', '总结文档')).rejects.toThrow(/不在允许清单里/)
    await r.knowledge.ingest('正文', 'design', 'spec')
    expect(r.knowledge.list('design')).toHaveLength(1)
  })

  it('applies the shipped default allowlist when the store config says nothing', async () => {
    const r = boot()
    await expect(r.knowledge.ingest('正文', 'Android', 's')).rejects.toThrow(/不在允许清单里/)
    await r.knowledge.ingest('正文', 'api', 's')
    expect(r.knowledge.list('api')).toHaveLength(1)
  })

  it('treats an explicitly empty allowlist as "no restriction"', async () => {
    const r = boot('domains: []\n')
    await r.knowledge.ingest('正文', 'Android', '总结文档')
    await r.knowledge.ingest('正文', 'iOS', '总结文档')
    expect(r.knowledge.list()).toHaveLength(2)
  })

  it('keeps a domain the library already holds usable after the allowlist narrows', async () => {
    const open = boot('domains: []\n')
    await open.knowledge.ingest('旧文档', 'Android', '总结文档', '总结文档')
    const narrowed = boot('domains:\n  - design\n')
    // The catalog (and therefore the picker and the guard) is the union, in configured-first order.
    expect(narrowed.knowledge.domainCatalog()).toEqual({ domains: ['design', 'Android'], restricted: true })
    // Same identity as the open store wrote, so this is a replace and the count stays 1 — the point
    // here is that the domain is still WRITABLE, not the title rule (`ingest` takes an explicit one).
    await narrowed.knowledge.ingest('新文档', 'Android', '总结文档', '总结文档')
    expect(narrowed.knowledge.list('Android')).toHaveLength(1)
    // A domain that is neither configured nor already present is still refused.
    await expect(narrowed.knowledge.ingest('正文', 'iOS', 's')).rejects.toThrow(/不在允许清单里/)
  })

  it('checks the domain in importPaths before walking the paths', async () => {
    const restricted = boot('domains:\n  - design\n')
    await expect(restricted.knowledge.importPaths([join(dir, 'nope')], 'x', 's')).rejects.toThrow(/不在允许清单里/)
  })

  it('reports the allowlist as unrestricted only for an explicitly empty list', () => {
    expect(boot().knowledge.domainCatalog().restricted).toBe(true)
    expect(boot('domains: []\n').knowledge.domainCatalog().restricted).toBe(false)
  })
})

describe('source defaults to `default`', () => {
  it('lands the document under (domain, `default`, title)', async () => {
    const r = boot('domains: []\n')
    const req = KbUnion.parse({ action: 'ingest', text: '缺省来源的正文。', domain: 'Android', title: '总结' })
    if (req.action !== 'ingest') throw new Error('the parsed request must be an ingest')
    expect(req.source).toBe('default')
    await r.kb(req)
    const rows = r.knowledge.list('Android', 'default')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ domain: 'Android', source: 'default', title: '总结' })
    // `default` is a normal path segment: the managed copy sits under it.
    expect(r.knowledge.docFilePathOf(rows[0]!)).toContain(join('Android', 'default', '总结.md'))
  })

  it('defaults the source on a DIRECT store call (no contract in the loop)', async () => {
    const r = boot('domains: []\n')
    // `undefined` for `source` is the shape `rt.kb` produced before the contract resolved it — the
    // store must not turn it into the identity `Android/undefined/直调`.
    await r.knowledge.ingest('直调存储的正文。', 'Android', undefined, '直调')
    const rows = r.knowledge.list('Android', 'default')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ domain: 'Android', source: 'default', title: '直调' })
    const file = r.knowledge.docFilePathOf(rows[0]!)
    expect(file).toContain(join('Android', 'default', '直调.md'))
    expect(file).not.toContain('undefined')
  })

  it('defaults the source for ingestUri and importPaths as well', async () => {
    const r = boot('domains: []\ningest:\n  allow_outside_workspace: true\n')
    const file = join(dir, 'note.md')
    writeFileSync(file, '导入正文：直调缺省来源。')
    await r.knowledge.ingestUri(file, 'Android')
    const imported = await r.knowledge.importPaths([file], 'Android')
    expect(imported.imported).toHaveLength(1)
    // Both calls title by basename, so the second is the same identity and REPLACES the first.
    const rows = r.knowledge.list('Android', 'default')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ domain: 'Android', source: 'default', title: 'note.md' })
    expect(r.knowledge.docFilePathOf(rows[0]!)).not.toContain('undefined')
  })
})
