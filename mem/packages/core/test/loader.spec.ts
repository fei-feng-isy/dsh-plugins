import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { familyModelsDir, familyToolsDir } from '@avantf/mem-contract'
import { loadConfig } from '../src/config/loader.js'
import { resolveDataHome } from '../src/config/paths.js'
import { defaultLogger } from '@avantf/mem-contract'

let dir: string

/**
 * The env layer ④ variables. Cleared per test: `vitest.config.ts` sets
 * `AVANTF_MEM_MODEL_CACHE` suite-wide (throwaway tmp cache), and a test that asserts the
 * layer-①/framework-root defaults would otherwise be reading that override.
 */
const MODEL_ENV = [
  'AVANTF_MEM_MODEL_MIRROR',
  'HF_ENDPOINT',
  'AVANTF_MEM_MODEL_CACHE',
  'AVANTF_MEM_AUTO_DOWNLOAD',
  'AVANTF_ENVINIT_AUTO_DOWNLOAD',
] as const
let savedEnv: Record<string, string | undefined>

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'avantf-cfg-'))
  mkdirSync(join(dir, 'configs'), { recursive: true })  // the config files live in one directory now
  savedEnv = {}
  for (const name of MODEL_ENV) {
    savedEnv[name] = process.env[name]
    delete process.env[name]
  }
})
afterEach(() => {
  for (const name of MODEL_ENV) {
    const value = savedEnv[name]
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  rmSync(dir, { recursive: true, force: true })
})

describe('config layering', () => {
  it('merges the common ~/.avantf/config.yaml (layer ②) section-deep', () => {
    writeFileSync(join(dir, 'configs', 'common.yaml'), 'retriever:\n  weight_fts: 0.42\nsemantic:\n  local_model: custom/model\n')
    const cfg = loadConfig({ dataHome: dir })
    expect(cfg.common.retriever.weight_fts).toBe(0.42)
    // untouched siblings keep their defaults (section-deep, not whole-section replace)
    expect(cfg.common.retriever.weight_semantic).toBe(0.55)
    expect(cfg.common.semantic.local_model).toBe('custom/model')
    expect(cfg.common.semantic.dim).toBe(512)
  })

  it('merges the per-store memory config.yaml (layer ③) — previously parsed and discarded', () => {
    mkdirSync(join(dir, 'memory'), { recursive: true })
    // `db.path` is the memory store's other override, and the only one left: `category_values` used
    // to sit here as the example, but no production code ever read it (DESIGN §3 records why it is
    // gone), so this test was asserting a config key with no meaning behind it.
    writeFileSync(join(dir, 'configs', 'memory.yaml'), 'db:\n  path: /tmp/mem-layer3.db\n')
    const cfg = loadConfig({ dataHome: dir })
    expect(cfg.memory.db.path).toBe('/tmp/mem-layer3.db')
  })

  it('merges the per-store knowledge config.yaml (layer ③)', () => {
    mkdirSync(join(dir, 'knowledge'), { recursive: true })
    writeFileSync(join(dir, 'configs', 'knowledge.yaml'), 'chunk_size: 400\nchunk_overlap: 40\ndomains:\n  - design\n')
    const cfg = loadConfig({ dataHome: dir })
    expect(cfg.knowledge.chunk_size).toBe(400)
    expect(cfg.knowledge.chunk_overlap).toBe(40)
    expect(cfg.knowledge.domains).toEqual(['design'])
  })

  it('defaults db paths under the data home', () => {
    const cfg = loadConfig({ dataHome: dir })
    expect(cfg.memory.db.path).toBe(join(dir, 'memory', 'memory.db'))
    expect(cfg.knowledge.db.path).toBe(join(dir, 'knowledge', 'knowledge.db'))
  })

  it('defaults the managed document directory beside the knowledge database', () => {
    const cfg = loadConfig({ dataHome: dir })
    // Same resolution rule as `db.path`: empty means "under the data home", and an explicit
    // value (or AVANTF_KNOWLEDGE_DOCS) is taken as-is / `~/`-expanded.
    expect(cfg.knowledge.docs.dir).toBe(join(dir, 'knowledge', 'docs'))
    mkdirSync(join(dir, 'knowledge'), { recursive: true })
    writeFileSync(join(dir, 'configs', 'knowledge.yaml'), 'docs:\n  dir: ~/avantf-test-docs\n')
    expect(loadConfig({ dataHome: dir }).knowledge.docs.dir).toBe(join(homedir(), 'avantf-test-docs'))
  })

  it('takes the family managed roots as the DEFAULT layer (①), and the model keys are managed', () => {
    // The DSH plugin points `tools.dir` / `semantic.cache_dir` / `rerank.cache_dir` at the framework's
    // family root. For TOOLS that is a new layer-① default: a value in config.yaml still wins. For the
    // MODEL landing site it is not a default at all — the managed root is authoritative, and a stale
    // `config.yaml` entry is ignored with a warning (see the next test).
    const roots = { tools: join(dir, 'env', 'tools'), models: join(dir, 'env', 'models') }

    // No managed roots (the CLI, the MCP server, the framework-unavailable fallback): the layer-①
    // default is the FAMILY root itself — the pre-framework `~/.avantf/{tools,models}` is not a
    // fallback anywhere, so nothing depends on a compatibility symlink existing.
    const bare = loadConfig({ dataHome: dir })
    expect(bare.common.tools.dir).toBe(familyToolsDir())
    expect(bare.common.semantic.cache_dir).toBe(familyModelsDir())
    expect(bare.common.rerank.cache_dir).toBe(familyModelsDir())

    const cfg = loadConfig({ dataHome: dir, managedRoots: roots })
    expect(cfg.common.tools.dir).toBe(roots.tools)
    expect(cfg.common.semantic.cache_dir).toBe(roots.models)
    expect(cfg.common.rerank.cache_dir).toBe(roots.models)

    writeFileSync(join(dir, 'configs', 'common.yaml'), 'tools:\n  dir: /custom/tools\nsemantic:\n  cache_dir: /custom/models\n')
    const overridden = loadConfig({ dataHome: dir, managedRoots: roots })
    expect(overridden.common.tools.dir).toBe('/custom/tools')
    // Managed: config.yaml cannot move the model root any more.
    expect(overridden.common.semantic.cache_dir).toBe(roots.models)
    expect(overridden.common.rerank.cache_dir).toBe(roots.models)
  })

  it('ignores config.yaml model cache/mirror and names the escape hatch', () => {
    const warnings: string[] = []
    writeFileSync(
      join(dir, 'configs', 'common.yaml'),
      'semantic:\n  cache_dir: /custom/models\n  mirror: https://mirror.test\n  local_model: still/allowed\n'
      + 'rerank:\n  cache_dir: /custom/rerank\n  mirror: https://rerank.test\n',
    )
    const cfg = loadConfig({ dataHome: dir, logger: { ...defaultLogger, warn: (m: string) => { warnings.push(m) } } })

    expect(cfg.common.semantic.cache_dir).toBe(familyModelsDir())
    expect(cfg.common.semantic.mirror).toBe('https://hf-mirror.com')
    expect(cfg.common.rerank.cache_dir).toBe(familyModelsDir())
    expect(cfg.common.rerank.mirror).toBe('https://hf-mirror.com')
    // Only the managed keys are dropped; the rest of the section still merges.
    expect(cfg.common.semantic.local_model).toBe('still/allowed')
    const joined = warnings.join('\n')
    expect(joined).toContain('semantic.cache_dir')
    expect(joined).toContain('rerank.mirror')
    expect(joined).toContain('AVANTF_MEM_MODEL_CACHE')
    expect(joined).toContain('AVANTF_MEM_MODEL_MIRROR')
  })

  it('uses an explicit absolute db.path verbatim', () => {
    mkdirSync(join(dir, 'memory'), { recursive: true })
    writeFileSync(join(dir, 'configs', 'memory.yaml'), `db:\n  path: ${join(dir, 'custom.db')}\n`)
    const cfg = loadConfig({ dataHome: dir })
    expect(cfg.memory.db.path).toBe(join(dir, 'custom.db'))
  })

  it('expands a ~/ db.path against the USER home (same rule as dataHome)', () => {
    mkdirSync(join(dir, 'knowledge'), { recursive: true })
    writeFileSync(join(dir, 'configs', 'knowledge.yaml'), 'db:\n  path: ~/avantf-test-store/knowledge.db\n')
    const cfg = loadConfig({ dataHome: dir })
    expect(cfg.knowledge.db.path).toBe(join(homedir(), 'avantf-test-store', 'knowledge.db'))
  })

  it('applies the env layer ④ (AVANTF_MEM_AUTO_DOWNLOAD) above YAML', () => {
    writeFileSync(join(dir, 'configs', 'common.yaml'), 'semantic:\n  auto_download: true\n')
    process.env['AVANTF_MEM_AUTO_DOWNLOAD'] = '0'
    try {
      const cfg = loadConfig({ dataHome: dir })
      expect(cfg.common.semantic.auto_download).toBe(false)
      expect(cfg.common.rerank.auto_download).toBe(false)
    } finally {
      delete process.env['AVANTF_MEM_AUTO_DOWNLOAD']
    }
  })

  it('treats AVANTF_ENVINIT_AUTO_DOWNLOAD as a master gate the adapters also see', () => {
    // The family switch has to reach the RESOLVED config, not just the framework's own provisioning:
    // otherwise the framework skips `mem:model` and the runtime silently fetches the same model.
    writeFileSync(join(dir, 'configs', 'common.yaml'), 'semantic:\n  auto_download: true\nrerank:\n  auto_download: true\n')
    process.env['AVANTF_ENVINIT_AUTO_DOWNLOAD'] = '0'
    const cfg = loadConfig({ dataHome: dir })
    expect(cfg.common.semantic.auto_download).toBe(false)
    expect(cfg.common.rerank.auto_download).toBe(false)
  })

  it('applies AVANTF_MEM_MODEL_MIRROR / HF_ENDPOINT to BOTH semantic and rerank (layer ④)', () => {
    // The plugin fills `mem:model`'s `spec.endpoint` from `semantic.mirror`, and the adapters read
    // the same value as transformers.js' `remoteHost`; leaving it at the default while the
    // config.yaml warning names these variables is exactly the M2 defect.
    process.env['HF_ENDPOINT'] = 'https://env-mirror.test'
    const fromHf = loadConfig({ dataHome: dir })
    expect(fromHf.common.semantic.mirror).toBe('https://env-mirror.test')
    expect(fromHf.common.rerank.mirror).toBe('https://env-mirror.test')

    // The project's own variable wins over HF_ENDPOINT — the same precedence the adapters use.
    process.env['AVANTF_MEM_MODEL_MIRROR'] = 'https://project-mirror.test'
    const project = loadConfig({ dataHome: dir })
    expect(project.common.semantic.mirror).toBe('https://project-mirror.test')
    expect(project.common.rerank.mirror).toBe('https://project-mirror.test')
  })

  it('applies AVANTF_MEM_MODEL_CACHE above the managed root, so the plugin can see the override', () => {
    // Both halves of M3: the runtime must READ the override, and the resolved config must SHOW it,
    // because the plugin only declares `mem:model` when `semantic.cache_dir` is the family root.
    const roots = { models: join(dir, 'env', 'models') }
    const override = join(dir, 'operator-models')
    process.env['AVANTF_MEM_MODEL_CACHE'] = override
    const cfg = loadConfig({ dataHome: dir, managedRoots: roots })
    expect(cfg.common.semantic.cache_dir).toBe(override)
    expect(cfg.common.rerank.cache_dir).toBe(override)
  })

  it('ignores malformed YAML instead of crashing', () => {
    writeFileSync(join(dir, 'configs', 'common.yaml'), ':\n\t- bad: [unclosed')
    const cfg = loadConfig({ dataHome: dir })
    expect(cfg.common.semantic.backend).toBe('local_bge')
  })

  it('lets an explicit dataHome (⑤) outrank AVANTF_HOME (④)', () => {
    // The env var used to win outright: `common.dataHome` always holds a value (the
    // schema default), so the loader could not tell "explicit" from "default" and an
    // explicit argument was silently discarded whenever AVANTF_HOME was set.
    process.env['AVANTF_HOME'] = join(dir, 'from-env')
    try {
      expect(loadConfig({ dataHome: join(dir, 'from-caller') }).home).toBe(join(dir, 'from-caller'))
      // …and ④ still applies when nothing explicit was passed
      expect(loadConfig().home).toBe(join(dir, 'from-env'))
    } finally {
      delete process.env['AVANTF_HOME']
    }
  })

  it('falls back to the ~/.avantf default when neither ④ nor ⑤ is set', () => {
    // Asserted on the pure resolver: `loadConfig()` would mkdir the real ~/.avantf.
    delete process.env['AVANTF_HOME']
    const common = { dataHome: '~/.avantf' }
    expect(resolveDataHome({ common })).toBe(join(homedir(), '.avantf'))
    expect(resolveDataHome({ common, explicit: '~/custom' })).toBe(join(homedir(), 'custom'))
    // A BARE `~` is the home directory, not a relative path called `~` — the two family copies used
    // to disagree on exactly this input (see `packages/plugin/test/family_pin.spec.ts`).
    expect(resolveDataHome({ common: { dataHome: '~' } })).toBe(homedir())
  })
})

describe('unknown-key warning (TRUST_MODEL.md §7 / R15+R23)', () => {
  it('warns for a root-level typo and for a typo inside a known section', () => {
    const warnings: string[] = []
    const original = defaultLogger.warn
    defaultLogger.warn = (m: string) => { warnings.push(m) }
    try {
      writeFileSync(join(dir, 'configs', 'common.yaml'), 'vector_store:\n  backend: hnswlib\nsemantic:\n  mirrors: https://x\n')
      loadConfig({ dataHome: dir })
    } finally {
      defaultLogger.warn = original
    }
    expect(warnings.some((w) => w.includes('vector_store'))).toBe(true)   // root-level typo
    expect(warnings.some((w) => w.includes('semantic.mirrors'))).toBe(true) // section-level typo
  })

  it('routes the warning to the INJECTED logger, not only the console default', () => {
    // The DSH host surfaces only what the plugin's logger carries, so a warning that
    // bypasses the injected sink never reaches an operator reading the host log.
    const seen: string[] = []
    const logger = { info: (): void => {}, warn: (m: string): void => { seen.push(m) }, error: (): void => {} }
    writeFileSync(join(dir, 'configs', 'common.yaml'), 'vector_store:\n  backend: hnswlib\n')
    loadConfig({ dataHome: dir, logger })
    expect(seen.some((w) => w.includes('vector_store'))).toBe(true)
  })

  it('stays quiet for a valid config', () => {
    const warnings: string[] = []
    const original = defaultLogger.warn
    defaultLogger.warn = (m: string) => { warnings.push(m) }
    try {
      writeFileSync(join(dir, 'configs', 'common.yaml'), 'semantic:\n  local_model: Xenova/custom\nvectorStore:\n  backend: local_numpy\n')
      loadConfig({ dataHome: dir })
    } finally {
      defaultLogger.warn = original
    }
    expect(warnings).toEqual([])
  })
})
