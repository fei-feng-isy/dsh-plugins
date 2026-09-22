/**
 * Build-time preset for a plugin repo.
 * @module preset
 */
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve as resolvePath } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  BOOTSTRAP_SUBPATH,
  FRAMEWORK_PACKAGE,
  MIN_INLINING_BEACONS,
  findFrameworkImports,
  findInliningBeacons,
  isBootstrapSpecifier,
} from './artifact.js'
import { VERSION as BOOTSTRAP_VERSION } from './bootstrap.js'
import { assertRange, satisfiesRange } from './semver.js'

export type PresetCheckStatus = 'pass' | 'fail' | 'skip'

/** One build-time assertion, with a stable id a repo can assert on. */
export interface PresetCheck {
  readonly id: string
  readonly status: PresetCheckStatus
  readonly message: string
}

export interface EnvinitPresetOptions {
  /** The plugin repo root; defaults to `process.cwd()`. */
  readonly cwd?: string
  /** Extra module names that must stay external (the plugin's own whitelist). */
  readonly external?: readonly string[]
  /** The declared framework range; when given it must equal `peerDependencies`. */
  readonly range?: string
  /** Assert against this framework copy instead of resolving one from `cwd`. */
  readonly frameworkDir?: string
}

export interface EnvinitPreset {
  /** The framework copy the assertions ran against. */
  readonly frameworkDir: string
  /** The framework package version found there. */
  readonly frameworkVersion: string
  /** The plugin's declared range (`peerDependencies`). */
  readonly declaredRange: string
  /** Names the bundler must keep external. */
  readonly external: readonly string[]
  /** Names the bundler must inline. */
  readonly noExternal: readonly string[]
  readonly checks: readonly PresetCheck[]
  readonly ok: boolean
}

interface CheckBuilder {
  readonly checks: PresetCheck[]
  pass(id: string, message: string): void
  fail(id: string, message: string): void
  skip(id: string, message: string): void
}

function builder(): CheckBuilder {
  const checks: PresetCheck[] = []
  return {
    checks,
    pass: (id, message) => checks.push({ id, status: 'pass', message }),
    fail: (id, message) => checks.push({ id, status: 'fail', message }),
    skip: (id, message) => checks.push({ id, status: 'skip', message }),
  }
}

function readJson(path: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined
  } catch {
    return undefined
  }
}

function readText(path: string): string | undefined {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return undefined
  }
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function keyCount(value: unknown): number {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? Object.keys(value).length : 0
}

/** The preset's own package root. */
function ownPackageDir(): string {
  return dirname(dirname(fileURLToPath(import.meta.url)))
}

/**
 * The base copy the PLUGIN's own tree resolves to: walk up from `cwd` looking for
 * `<dir>/node_modules/@avantf/dsh-plugin-base/package.json`.
 *
 * Deliberately NOT `createRequire(...).resolve()`: that also consults the process-wide `NODE_PATH`,
 * which package-manager shims (pnpm's `.bin` shims set it to the virtual store) and developer shells
 * export. A plugin whose own tree has no base would then be reported as `pass` — the exact false
 * green this check exists to catch. Only the plugin's directory chain may answer.
 */
function resolveFrameworkDir(cwd: string): string | undefined {
  let current = resolvePath(cwd)
  for (;;) {
    const candidate = join(current, 'node_modules', FRAMEWORK_PACKAGE)
    if (existsSync(join(candidate, 'package.json'))) return candidate
    const parent = dirname(current)
    if (parent === current) return undefined
    current = parent
  }
}

/** Build configuration and build-time assertions. */
export function envinitPreset(options: EnvinitPresetOptions = {}): EnvinitPreset {
  const cwd = options.cwd ?? process.cwd()
  const external = [FRAMEWORK_PACKAGE, ...(options.external ?? []).filter(name => name !== FRAMEWORK_PACKAGE)]
  const noExternal = [BOOTSTRAP_SUBPATH]
  const out = builder()

  const frameworkDir = options.frameworkDir ?? resolveFrameworkDir(cwd)
  if (frameworkDir === undefined) {
    out.fail('preset/framework-resolvable', `无法从 ${cwd} 解析 ${FRAMEWORK_PACKAGE}/package.json`)
    return { frameworkDir: '', frameworkVersion: '', declaredRange: '', external, noExternal, checks: out.checks, ok: false }
  }

  const frameworkPkg = readJson(join(frameworkDir, 'package.json'))
  const frameworkVersion = str(frameworkPkg?.['version'])
  if (frameworkPkg === undefined || frameworkVersion === undefined) {
    out.fail('preset/framework-resolvable', `${frameworkDir}/package.json 不可读或缺少 version`)
    return { frameworkDir, frameworkVersion: '', declaredRange: '', external, noExternal, checks: out.checks, ok: false }
  }
  out.pass('preset/framework-resolvable', `${FRAMEWORK_PACKAGE}@${frameworkVersion} @ ${frameworkDir}`)

  // ── preset/package version agreement ───────────────────────────────────────
  const ownPkg = readJson(join(ownPackageDir(), 'package.json'))
  const ownVersion = str(ownPkg?.['version'])
  if (ownVersion === frameworkVersion) {
    out.pass('preset/preset-version-matches-package', `preset ${ownVersion ?? '?'} = 框架包 ${frameworkVersion}`)
  } else {
    out.fail(
      'preset/preset-version-matches-package',
      `预设版本 ${ownVersion ?? '(未知)'} ≠ 框架包版本 ${frameworkVersion}（预设必须与框架同版）`,
    )
  }

  // ── bootstrap/package version agreement ────────────────────────────────────
  if (BOOTSTRAP_VERSION === frameworkVersion) {
    out.pass('preset/bootstrap-version-matches-package', `bootstrap ${BOOTSTRAP_VERSION} = 框架包 ${frameworkVersion}`)
  } else {
    out.fail(
      'preset/bootstrap-version-matches-package',
      `bootstrap 版本常量 ${BOOTSTRAP_VERSION} ≠ 框架包版本 ${frameworkVersion}`,
    )
  }

  // ── base self-containment ──────────────────────────────────────────────────
  // The base is resolved and `import()`ed by the plugin's inlined bootstrap, so it must bring no
  // runtime dependency of its own: `dependencies` stays empty. It has EXACTLY ONE permitted peer —
  // `zod`, which the compatibility gate's typert probe needs and which must be the HOST's copy (two
  // zod copies, even of the same major, have incompatible schema identities). Any dependency, any
  // second peer, means the base is no longer self-contained.
  const runtimeDeps = keyCount(frameworkPkg['dependencies'])
  const peers = frameworkPkg['peerDependencies']
  const peerNames =
    typeof peers === 'object' && peers !== null && !Array.isArray(peers) ? Object.keys(peers) : []
  const unexpectedPeers = peerNames.filter(name => name !== 'zod')
  if (runtimeDeps === 0 && unexpectedPeers.length === 0) {
    out.pass(
      'preset/framework-self-contained',
      `dependencies 为空；peerDependencies = ${peerNames.length === 0 ? '(空)' : peerNames.join(', ')}`,
    )
  } else {
    out.fail(
      'preset/framework-self-contained',
      `框架包必须自包含：dependencies 必须为空（现有 ${String(runtimeDeps)} 条）；peerDependencies 只允许 zod（现有多余 ${unexpectedPeers.join(', ') || '(无)'}）`,
    )
  }

  // ── declared range ─────────────────────────────────────────────────────────
  const pluginPkg = readJson(join(cwd, 'package.json'))
  if (pluginPkg === undefined) {
    out.fail('preset/peer-range-declared', `${join(cwd, 'package.json')} 不可读`)
    return { frameworkDir, frameworkVersion, declaredRange: '', external, noExternal, checks: out.checks, ok: false }
  }
  const peer = pluginPkg['peerDependencies']
  const declaredRange = typeof peer === 'object' && peer !== null ? str((peer as Record<string, unknown>)[FRAMEWORK_PACKAGE]) : undefined
  if (declaredRange === undefined) {
    out.fail('preset/peer-range-declared', `插件必须在 peerDependencies 声明 ${FRAMEWORK_PACKAGE} 的区间`)
    return { frameworkDir, frameworkVersion, declaredRange: '', external, noExternal, checks: out.checks, ok: false }
  }
  try {
    assertRange(declaredRange)
    out.pass('preset/peer-range-declared', `peerDependencies["${FRAMEWORK_PACKAGE}"] = ${declaredRange}`)
  } catch (error) {
    out.fail('preset/peer-range-declared', `区间不在支持的 semver 子集内：${declaredRange}（${error instanceof Error ? error.message : String(error)}）`)
  }

  const dev = pluginPkg['devDependencies']
  const devRange = typeof dev === 'object' && dev !== null ? str((dev as Record<string, unknown>)[FRAMEWORK_PACKAGE]) : undefined
  const rangeProblems: string[] = []
  if (devRange !== declaredRange) rangeProblems.push(`devDependencies 是 ${devRange ?? '(缺失)'}，应与 peerDependencies 同区间`)
  if (options.range !== undefined && options.range !== declaredRange) {
    rangeProblems.push(`传入的 range 是 ${options.range}，应等于 peerDependencies`)
  }
  if (rangeProblems.length === 0) {
    out.pass('preset/range-single-source', `peerDependencies ≡ devDependencies = ${declaredRange}`)
  } else {
    out.fail('preset/range-single-source', rangeProblems.join('；'))
  }

  // ── bootstrap version in range ─────────────────────────────────────────────
  if (satisfiesRange(BOOTSTRAP_VERSION, declaredRange)) {
    out.pass('preset/bootstrap-version-in-range', `bootstrap ${BOOTSTRAP_VERSION} ∈ ${declaredRange}`)
  } else {
    out.fail(
      'preset/bootstrap-version-in-range',
      `bootstrap 版本 ${BOOTSTRAP_VERSION} 不在插件声明的区间 ${declaredRange} 内（构建必须失败）`,
    )
  }

  return {
    frameworkDir,
    frameworkVersion,
    declaredRange,
    external,
    noExternal,
    checks: out.checks,
    ok: out.checks.every(check => check.status !== 'fail'),
  }
}

/** Throw when any assertion failed; the message lists the failing rule ids. */
export function assertEnvinitPreset(preset: EnvinitPreset): void {
  assertEnvinitPresetChecks(preset.checks)
}

export interface ArtifactAssertOptions {
  /** Server-side artifacts that must inline the bootstrap and keep `.` external. */
  readonly artifacts?: readonly string[]
  /** Client-side artifacts that must not mention the framework at all. */
  readonly clientArtifacts?: readonly string[]
}

/** Post-build scan; returns the checks. {@link assertEnvinitPresetChecks} turns failures into a build error. */
export function assertEnvinitArtifacts(options: ArtifactAssertOptions): readonly PresetCheck[] {
  const checks: PresetCheck[] = []

  const server = options.artifacts ?? []
  if (server.length === 0) {
    checks.push({ id: 'preset/server-artifacts-external-only', status: 'skip', message: '未提供服务端产物路径' })
  } else {
    const offenders: string[] = []
    for (const path of server) {
      const text = readText(path)
      if (text === undefined) {
        offenders.push(`${path}: 不可读`)
        continue
      }
      for (const found of findFrameworkImports(text)) {
        if (isBootstrapSpecifier(found.specifier)) {
          offenders.push(`${path}: ${found.specifier} 必须被内联，产物里不得留下该 import`)
        }
      }
      const beacons = findInliningBeacons(text)
      if (beacons.length >= MIN_INLINING_BEACONS) {
        offenders.push(`${path}: 框架本包被内联（命中控制面字面量 ${beacons.join(', ')}），\`.\` 必须保持外部`)
      }
    }
    checks.push(
      offenders.length === 0
        ? { id: 'preset/server-artifacts-external-only', status: 'pass', message: `${String(server.length)} 个服务端产物：bootstrap 已内联、框架本包保持外部` }
        : { id: 'preset/server-artifacts-external-only', status: 'fail', message: offenders.join('；') },
    )
  }

  const client = options.clientArtifacts ?? []
  if (client.length === 0) {
    checks.push({ id: 'preset/client-artifacts-clean', status: 'skip', message: '未提供 client 产物路径' })
  } else {
    const offenders: string[] = []
    for (const path of client) {
      const text = readText(path)
      if (text === undefined) {
        offenders.push(`${path}: 不可读`)
        continue
      }
      const specifiers = [...new Set(findFrameworkImports(text).map(found => found.specifier))]
      if (specifiers.length > 0) offenders.push(`${path}: client 产物不得 import 框架（${specifiers.join(', ')}）`)
    }
    checks.push(
      offenders.length === 0
        ? { id: 'preset/client-artifacts-clean', status: 'pass', message: `${String(client.length)} 个 client 产物：无框架 import` }
        : { id: 'preset/client-artifacts-clean', status: 'fail', message: offenders.join('；') },
    )
  }

  return checks
}

/** Turn any failing check into a thrown build error. */
export function assertEnvinitPresetChecks(checks: readonly PresetCheck[]): void {
  const failed = checks.filter(check => check.status === 'fail')
  if (failed.length === 0) return
  throw new Error(`dsh-plugin-base 产物断言失败：\n${failed.map(check => `  [${check.id}] ${check.message}`).join('\n')}`)
}
