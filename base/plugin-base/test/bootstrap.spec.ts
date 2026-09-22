/**
 * The inlined bootstrap: it RESOLVES the framework copy the caller's own tree
 * already has, and installs nothing — no private copy under the family root, no registry download.
 *
 * The "not installed" and "outside supportedRange" cases run in a child process that imports a COPY
 * of the built bootstrap from a scratch tree: in-process resolution would always find this
 * repository itself, which is exactly the copy these cases must not be confused with.
 *
 * The plugin's own declared range is NOT judged here; the framework reports `unsupported-envinit`
 * per manifest once it is loaded.
 *
 * @module test/bootstrap
 */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { VERSION, ensureFramework, loadFramework, readDependencyRange, supportedRange } from '../src/bootstrap.js'
import { removeHome } from './helpers/tmp.js'

const PACKAGE = '@avantf/dsh-plugin-base'
const REPO_ROOT = dirname(dirname(fileURLToPath(import.meta.url)))
const DIST_BOOTSTRAP = join(REPO_ROOT, 'dist', 'bootstrap.js')
const CHILD = join(REPO_ROOT, 'test', 'helpers', 'bootstrap-child.mjs')

/** Install a fake framework where the caller's tree resolves it. */
async function installFramework(tree: string, version: string, marker: string): Promise<void> {
  const dir = join(tree, 'node_modules', ...PACKAGE.split('/'))
  await mkdir(join(dir, 'dist'), { recursive: true })
  await writeFile(join(dir, 'package.json'), JSON.stringify({
    name: PACKAGE,
    version,
    type: 'module',
    // `./package.json` too: resolution goes through the manifest, exactly as the published package
    // allows it.
    exports: { '.': { default: './dist/index.js' }, './package.json': './package.json' },
  }))
  await writeFile(join(dir, 'dist', 'index.js'), `export const marker = ${JSON.stringify(marker)}\n`)
}

interface ChildResult {
  readonly warnings: readonly string[]
  readonly location?: unknown
  readonly marker?: string
}

/** Run one caller process against a copy of the built bootstrap inside `tree`. */
async function callChild(tree: string, scenario: 'absent' | 'present' | 'unsupported', options?: Record<string, unknown>): Promise<ChildResult> {
  const copy = join(tree, 'bootstrap.mjs')
  await copyFile(DIST_BOOTSTRAP, copy)
  // A scrubbed environment: the point of the scenario is that only this tree can satisfy resolution.
  const env = { ...process.env }
  delete env['NODE_PATH']
  delete env['NODE_OPTIONS']
  const argv = [CHILD, copy, scenario]
  if (options !== undefined) argv.push(JSON.stringify(options))
  const stdout = execFileSync(process.execPath, argv, { encoding: 'utf8', cwd: tree, env })
  const line = stdout.trim().split('\n').at(-1) ?? '{}'
  return JSON.parse(line) as ChildResult
}

const warnings: string[] = []
const logger = { warn: (message: string) => warnings.push(message), info: () => undefined }
const silent = { debug: () => undefined, info: () => undefined, warn: () => undefined, error: () => undefined }

describe('bootstrap（零依赖自包含）', () => {
  let scratch: string

  beforeEach(async () => {
    scratch = await mkdtemp(join(tmpdir(), 'envinit-bootstrap-'))
    warnings.length = 0
  })
  afterEach(async () => {
    await removeHome(scratch)
  })

  it('版本常量与 supportedRange 自洽', () => {
    expect(VERSION).toMatch(/^\d+\.\d+\.\d+/)
    expect(supportedRange).toMatch(/^\^\d+/)
    expect(supportedRange).toContain(VERSION)
  })

  it('解析调用方依赖树里的安装副本，且不写任何东西', async () => {
    const location = await ensureFramework({ logger })
    expect(location).toMatchObject({ source: 'resolved', version: VERSION })
    expect(location?.url).toMatch(/\/dist\/index\.js$/)
    expect(warnings).toEqual([])
    // Nothing was installed anywhere: no family control plane came into being.
    expect(existsSync(join(scratch, '.envinit'))).toBe(false)
  })

  it('超出 supportedRange ⇒ 告警 + undefined', async () => {
    await expect(ensureFramework({ supportedRange: '^9.0.0', logger })).resolves.toBeUndefined()
    expect(warnings.join(' ')).toContain('supportedRange')
  })

  it('非法输入也不抛（Never throws）', async () => {
    await expect(ensureFramework({ supportedRange: 42 as unknown as string, logger })).resolves.toBeUndefined()
    expect(warnings.join(' ')).toContain('supportedRange must be a string')
  })

  it('框架没有安装 ⇒ 告警 + undefined，且不落地任何副本来代替', async () => {
    const result = await callChild(scratch, 'absent')
    expect(result.location).toBeUndefined()
    expect(result.warnings.join(' ')).toContain('not installed')
    // The package manager is the only source: no private copy, no registry download, no control plane.
    expect(existsSync(join(scratch, '.envinit'))).toBe(false)
    expect(existsSync(join(scratch, 'node_modules'))).toBe(false)
  })

  it('框架装在同一棵树里 ⇒ 动态 import 到它，不碰 registry', async () => {
    await installFramework(scratch, VERSION, 'installed-copy')
    const result = await callChild(scratch, 'present')
    expect(result.marker).toBe('installed-copy')
    expect(result.warnings).toEqual([])
  })

  it('树里的那份版本不被 supportedRange 接受 ⇒ 告警 + undefined（不下载替代）', async () => {
    await installFramework(scratch, '9.9.9', 'wrong-version')
    const result = await callChild(scratch, 'unsupported')
    expect(result.location).toBeUndefined()
    expect(result.warnings.join(' ')).toContain('supportedRange')
  })

  it('预发布版本只被点名预发布的比较符匹配（与 core 的 semver 同一规则）', async () => {
    await installFramework(scratch, '0.2.1-beta.1', 'prerelease')
    const rejected = await callChild(scratch, 'unsupported', { supportedRange: '^0.2.0' })
    expect(rejected.location).toBeUndefined()
    expect(rejected.warnings.join(' ')).toContain('supportedRange')

    await installFramework(scratch, '0.2.1', 'release')
    const accepted = await callChild(scratch, 'present', { supportedRange: '^0.2.0' })
    expect(accepted.marker).toBe('release')
  })

  it('部分比较符与 npm 同义：">0.2" = ">=0.3.0"，不接受 0.2.1（与 core 同一展开）', async () => {
    await installFramework(scratch, '0.2.1', 'partial')
    const rejected = await callChild(scratch, 'unsupported', { supportedRange: '>0.2' })
    expect(rejected.location).toBeUndefined()
    expect(rejected.warnings.join(' ')).toContain('supportedRange')

    await installFramework(scratch, '0.3.0', 'next-minor')
    const accepted = await callChild(scratch, 'present', { supportedRange: '>0.2' })
    expect(accepted.marker).toBe('next-minor')
  })

  it('插件声明的区间不在这里判：装载后的框架按清单隔离', async () => {
    const framework = await loadFramework<typeof import('../src/index.js')>({ logger })
    expect(framework).toBeDefined()
    const provisioner = framework!.createProvisioner({ home: scratch, logger: silent, envinitRange: '^9.0.0' })
    provisioner.declare({
      plugin: 'demo',
      items: [{ id: 'demo:anything', kind: 'plugin:stub', spec: {}, target: { root: 'runtime' }, schemaVersion: 1 }],
    })
    const report = await provisioner.ensure()
    expect(report.entries.map(entry => [entry.action, entry.code])).toEqual([['skipped', 'unsupported-envinit']])
  })

  describe('readDependencyRange（唯一来源）', () => {
    async function repo(name: string, pkg: unknown): Promise<string> {
      const dir = join(scratch, name)
      await mkdir(dir, { recursive: true })
      await writeFile(join(dir, 'package.json'), typeof pkg === 'string' ? pkg : JSON.stringify(pkg))
      return dir
    }

    it('读 peerDependencies 的区间，并从子目录向上找到它', async () => {
      const dir = await repo('plugin', { name: 'demo', peerDependencies: { [PACKAGE]: '^1.2.0' } })
      await mkdir(join(dir, 'src', 'deep'), { recursive: true })
      await expect(readDependencyRange(dir)).resolves.toBe('^1.2.0')
      await expect(readDependencyRange(join(dir, 'src', 'deep'))).resolves.toBe('^1.2.0')
      await expect(readDependencyRange(join(dir, 'index.js'))).resolves.toBe('^1.2.0')
    })

    it('接受 file:// URL，而不是把它当路径爬到 cwd', async () => {
      const dir = await repo('url-plugin', { name: 'demo', peerDependencies: { [PACKAGE]: '^1.2.0' } })
      await expect(readDependencyRange(pathToFileURL(join(dir, 'index.js')).href)).resolves.toBe('^1.2.0')
    })

    it('畸形的 file:// URL 不抛（posix 上 host 非法）', async () => {
      const result = await readDependencyRange('file://host/share/x.js')
      if (process.platform !== 'win32') expect(result).toBeUndefined()
    })

    it('没有 peer 时退到 devDependencies（本地构建/测试区间）', async () => {
      const dir = await repo('dev-only', { name: 'demo', devDependencies: { [PACKAGE]: '~1.2.0' } })
      await expect(readDependencyRange(dir)).resolves.toBe('~1.2.0')
    })

    it('只声明 dependencies 不算数（那会装出多份框架副本）', async () => {
      const dir = await repo('deps-only', { name: 'demo', dependencies: { [PACKAGE]: '^1.2.0' } })
      await expect(readDependencyRange(dir)).resolves.toBeUndefined()
    })

    it('最近的那份 package.json 不可解析 ⇒ 不去读更远的那份', async () => {
      const parent = await repo('outer', { name: 'outer', peerDependencies: { [PACKAGE]: '^9.0.0' } })
      const child = join(parent, 'inner')
      await mkdir(child, { recursive: true })
      await writeFile(join(child, 'package.json'), '{ not json')
      await expect(readDependencyRange(child)).resolves.toBeUndefined()
    })

    it('一路到根都没有 package.json ⇒ undefined，不抛', async () => {
      const bare = join(scratch, 'bare', 'nested')
      await mkdir(bare, { recursive: true })
      await expect(readDependencyRange(join(bare, 'nothing'))).resolves.toBeUndefined()
    })
  })

  it('loadFramework 在没有框架时返回 undefined（降级挂载，不抛）', async () => {
    await expect(loadFramework({ supportedRange: '^9.0.0', logger })).resolves.toBeUndefined()
  })
})
