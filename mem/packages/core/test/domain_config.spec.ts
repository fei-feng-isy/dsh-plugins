/**
 * 知识域「+」: the store-config writer and its LIVE effect.
 *
 * The UI adds a domain through the UI-only `kbAddDomain` path, which reaches
 * `KnowledgeStore.addDomain`. Two properties matter and neither is visible from the UI code:
 *
 *  - the write goes back into `~/.avantf/configs/knowledge.yaml` (layer ③ of `loader.ts`, the ONLY
 *    source of truth for the allowlist) and keeps the comments around it, so a documented config
 *    does not become a bare list;
 *  - the allowlist is a LIVE in-memory set, so the new domain is usable immediately — the config
 *    file is read once at startup, and "restart dsh first" would be a bug, not a caveat.
 *
 * Rendering is not exercised here (that is the plugin spec's pure-helper approach); this file pins
 * the store + writer contracts the UI stands on.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parse } from 'yaml'
import { buildRuntime, type AvantfRuntime } from '../src/index.js'
import { addKnowledgeDomain } from '../src/config/domains.js'

let dir: string
let rt: AvantfRuntime | undefined

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'avf-domain-add-'))
  mkdirSync(join(dir, 'configs'), { recursive: true })  // the config files live in one directory now
  rt = undefined
})
afterEach(() => { rt?.shutdown(); rmSync(dir, { recursive: true, force: true }) })

/** The store config file the writer owns. */
const configPath = (): string => join(dir, 'configs', 'knowledge.yaml')

/** Boot a runtime whose store config is exactly `yaml`. */
function boot(yaml: string): AvantfRuntime {
  mkdirSync(join(dir, 'knowledge'), { recursive: true })
  writeFileSync(configPath(), yaml)
  rt?.shutdown()
  rt = buildRuntime({ dataHome: dir })
  return rt
}

describe('addKnowledgeDomain (store config writer)', () => {
  it('appends the domain and keeps every comment in the file', () => {
    mkdirSync(join(dir, 'knowledge'), { recursive: true })
    writeFileSync(configPath(), '# 这份文件的注释是文档，不能被写没\nopen:\n  editor: code  # 打开方式\n# 允许的领域\ndomains:\n  - design  # 原有\n')
    expect(addKnowledgeDomain(configPath(), 'legal')).toEqual(['design', 'legal'])
    const text = readFileSync(configPath(), 'utf8')
    expect(text).toContain('# 这份文件的注释是文档，不能被写没')
    expect(text).toContain('# 打开方式')
    expect(text).toContain('# 允许的领域')
    expect(text).toContain('# 原有')
    expect(parse(text)).toMatchObject({ open: { editor: 'code' }, domains: ['design', 'legal'] })
  })

  it('creates a missing `domains` key without touching its siblings', () => {
    mkdirSync(join(dir, 'knowledge'), { recursive: true })
    writeFileSync(configPath(), 'open:\n  editor: code\n')
    addKnowledgeDomain(configPath(), 'legal')
    expect(parse(readFileSync(configPath(), 'utf8'))).toMatchObject({
      open: { editor: 'code' },
      domains: ['legal'],
    })
  })

  it('creates the file when the store has no config yet', () => {
    addKnowledgeDomain(configPath(), 'legal')
    expect(parse(readFileSync(configPath(), 'utf8')).domains).toEqual(['legal'])
  })

  it('does not duplicate a domain that is already listed', () => {
    mkdirSync(join(dir, 'knowledge'), { recursive: true })
    writeFileSync(configPath(), 'domains:\n  - design\n')
    expect(addKnowledgeDomain(configPath(), 'design')).toEqual(['design'])
    expect(parse(readFileSync(configPath(), 'utf8')).domains).toEqual(['design'])
  })
})

describe('KnowledgeStore.addDomain', () => {
  it('makes the new domain usable immediately (no restart) and persists it', async () => {
    const r = boot('# 保留注释\ndomains:\n  - design\n')
    expect(r.knowledge.domainCatalog()).toEqual({ domains: ['design'], restricted: true })
    expect(r.knowledge.addDomain(' legal ')).toEqual({ domains: ['design', 'legal'], restricted: true })
    // Same process, same store: the live set already accepts it.
    await r.knowledge.ingest('新增领域的正文。', 'legal', 'spec')
    expect(r.knowledge.list('legal')).toHaveLength(1)
    // And the next boot reads the same value back out of the config.
    const text = readFileSync(configPath(), 'utf8')
    expect(text).toContain('# 保留注释')
    expect(parse(text).domains).toEqual(['design', 'legal'])
  })

  it('treats an existing domain as a selection: no second write', () => {
    const r = boot('# 保留注释\ndomains:\n  - design\n')
    const before = readFileSync(configPath(), 'utf8')
    expect(r.knowledge.addDomain('design')).toEqual({ domains: ['design'], restricted: true })
    expect(readFileSync(configPath(), 'utf8')).toBe(before)
  })

  it('selects a domain the library already holds instead of writing it to the config', async () => {
    // `legacy` is not in the allowlist, but the library has it — the catalog offers it, so `+`
    // must not write a duplicate of a name that is already usable.
    const open = boot('domains: []\n')
    await open.knowledge.ingest('旧领域文档', 'legacy', 's')
    const narrowed = boot('domains:\n  - design\n')
    expect(narrowed.knowledge.domainCatalog()).toEqual({ domains: ['design', 'legacy'], restricted: true })
    const before = readFileSync(configPath(), 'utf8')
    expect(narrowed.knowledge.addDomain('legacy')).toEqual({ domains: ['design', 'legacy'], restricted: true })
    expect(readFileSync(configPath(), 'utf8')).toBe(before)
  })

  it('refuses empty and path-separator names', () => {
    const r = boot('domains:\n  - design\n')
    expect(() => r.knowledge.addDomain('   ')).toThrow('知识域不能为空')
    expect(() => r.knowledge.addDomain('a/b')).toThrow(/不能包含/)
    expect(() => r.knowledge.addDomain('a\\b')).toThrow(/不能包含/)
  })

  it('refuses to add while the allowlist is [] (that would silently restrict it)', async () => {
    const r = boot('# 显式空数组 = 不限制\ndomains: []\n')
    const before = readFileSync(configPath(), 'utf8')
    expect(() => r.knowledge.addDomain('legal')).toThrow(/不限制/)
    expect(readFileSync(configPath(), 'utf8')).toBe(before)
    // The `[]` semantics are untouched: an unlisted domain still writes.
    await r.knowledge.ingest('不限制领域的正文。', 'anything', 's')
    expect(r.knowledge.list('anything')).toHaveLength(1)
  })
})
