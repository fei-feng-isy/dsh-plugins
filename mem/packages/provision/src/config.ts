/**
 * The `tools` config section: where managed tools live, which mirrors to try, and whether a missing
 * artifact may be fetched automatically.
 *
 * The defaults are the user's explicit requirement — DOMESTIC MIRRORS FIRST, official source as the
 * fallback. The mirror list is a list of URL TEMPLATES rather than base URLs because the popular
 * proxies disagree about the separator (`https://ghproxy.net/https://github.com/…`), so a template
 * with `{url}` is the only shape that expresses both without a per-mirror special case.
 *
 * @module config
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ProvisionConfig } from './types.js'

/**
 * Domestic GitHub-release proxies, tried before the official source.
 *
 * HONEST STATUS (measured on this machine, 2026-09-17): none of them could be reached — every one
 * either did not resolve or presented a TLS chain this host rejects (`SELF_SIGNED_CERT_IN_CHAIN`),
 * which is what a network-level interception of those domains looks like. They stay in the list
 * because a working proxy is the difference between a 35 MB download at GitHub speed and one that
 * times out; the official source is always the last candidate, and `ensure` reports EVERY source it
 * tried when none missions, so a dead proxy can never be mistaken for a failed install. Set
 * `tools.mirror: []` to skip them entirely.
 */
export const DEFAULT_MIRRORS: readonly string[] = [
  'https://ghfast.top/{url}',
  'https://ghproxy.net/{url}',
  'https://gh-proxy.com/{url}',
]

/** The built-in `tools` section (layer ①); the config schema defaults to exactly this shape. */
export const DEFAULT_TOOLS_CONFIG: ProvisionConfig = {
  // Empty = "the family root's `tools`" (`defaultToolsDir()`): the pre-framework `~/.avantf/tools`
  // is not a fallback anywhere any more, so nothing has to survive as a compatibility symlink.
  dir: '',
  mirror: DEFAULT_MIRRORS,
  auto_install: true,
}

/**
 * The managed directory a process falls back to when it has no resolved config yet.
 *
 * Exported (rather than inlined where it is used) so an artifact's `isPresent` can answer "is the
 * tool already here?" before any runtime has installed its settings — which is what keeps a startup
 * sweep from re-downloading a tool that is already on disk.
 */
export function defaultToolsDir(env: NodeJS.ProcessEnv = process.env): string {
  return familyToolsDir(env)
}

/**
 * The family root and its managed directories — `$AVANTF_HOME` when set, else `~/.avantf/env`.
 *
 * Mirrored from `@avantf/mem-contract`'s `familyHome()` / `familyToolsDir()`: this package is
 * deliberately dependency-free (node builtins only), so it cannot import them, and
 * `packages/core/test/family_paths.spec.ts` pins the two copies together so the convention cannot
 * drift. `@avantf/dsh-plugin-base` installs everything it manages under this one root.
 */
export function familyHome(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env['AVANTF_HOME']
  return configured !== undefined && configured.trim() !== '' ? expandHome(configured.trim()) : join(homedir(), '.avantf', 'env')
}

/** The managed external-binary root (`<family root>/tools`). */
export function familyToolsDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(familyHome(env), 'tools')
}

/**
 * The project-wide download kill switch (`AVANTF_MEM_AUTO_DOWNLOAD=0`), the same variable the model
 * adapters honour: one switch that makes EVERY provisioning path offline, which is what a test suite
 * and a deliberately offline host both need. `undefined` means "not set" (the configured value
 * applies); `'0'`/`'false'` means off, anything else means on.
 */
export function envAutoInstall(env: NodeJS.ProcessEnv = process.env): boolean | undefined {
  const raw = env['AVANTF_MEM_AUTO_DOWNLOAD']
  if (raw === undefined || raw === '') return undefined
  return raw !== '0' && raw.toLowerCase() !== 'false'
}

/**
 * Apply the environment layer to a resolved tools config. Two variables, matching the data-home
 * escape hatch's style: the directory (see {@link resolveToolsDir}) and the kill switch above.
 */
export function applyToolsEnv(config: ProvisionConfig, env: NodeJS.ProcessEnv = process.env): ProvisionConfig {
  const autoInstall = envAutoInstall(env)
  const dir = env['AVANTF_TOOLS_DIR']
  return {
    dir: dir !== undefined && dir !== '' ? dir : config.dir,
    mirror: config.mirror,
    auto_install: autoInstall ?? config.auto_install,
  }
}

/** Expand a leading `~/` against the user home; absolute paths pass through. */
export function expandHome(path: string): string {
  if (path === '~') return homedir()
  return path.startsWith('~/') ? join(homedir(), path.slice(2)) : path
}

/**
 * The managed tools root.
 *
 * `AVANTF_TOOLS_DIR` is the environment layer (the same escape hatch `AVANTF_HOME` gives the data
 * home), then the configured value, then the built-in default. `~` is expanded here rather than at
 * the call site so every caller agrees on one directory.
 */
export function resolveToolsDir(config: ProvisionConfig, env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env['AVANTF_TOOLS_DIR']
  if (fromEnv !== undefined && fromEnv !== '') return expandHome(fromEnv)
  if (config.dir !== '') return expandHome(config.dir)
  return defaultToolsDir(env)
}

/**
 * Read the `tools` section out of an UNVALIDATED config object (the value comes from YAML, so every
 * field has to be checked here — a wrong type must not reach the installer as a surprise).
 *
 * Unknown keys are not this function's business: the engine's config loader warns about them for the
 * whole file (see `packages/core/src/config/loader.ts`).
 */
export function parseToolsConfig(raw: unknown): ProvisionConfig {
  if (raw === undefined || raw === null) return { ...DEFAULT_TOOLS_CONFIG }
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`tools 配置必须是一个对象，实际是 ${Array.isArray(raw) ? 'array' : typeof raw}`)
  }
  const source = raw as Record<string, unknown>
  const dir = source['dir']
  if (dir !== undefined && typeof dir !== 'string') throw new Error('tools.dir 必须是字符串')
  const mirror = source['mirror']
  if (mirror !== undefined && (!Array.isArray(mirror) || mirror.some(entry => typeof entry !== 'string'))) {
    throw new Error('tools.mirror 必须是字符串数组（URL 模板，用 {url} 占位原始地址）')
  }
  const autoInstall = source['auto_install']
  if (autoInstall !== undefined && typeof autoInstall !== 'boolean') throw new Error('tools.auto_install 必须是布尔值')
  return {
    dir: dir ?? DEFAULT_TOOLS_CONFIG.dir,
    mirror: mirror === undefined ? [...DEFAULT_TOOLS_CONFIG.mirror] : [...(mirror as string[])],
    auto_install: autoInstall ?? DEFAULT_TOOLS_CONFIG.auto_install,
  }
}
