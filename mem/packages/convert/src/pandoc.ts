/**
 * Resolving the pandoc binary for the converter.
 *
 * The binary is NOT this package's business to install — `@avantf/mem-provision` owns that, the
 * pinned version, the mirror list, and the managed-tools layout. What this module adds is the
 * converter's view of it: one place that knows how to ask for the executable, where an explicit
 * override goes, and why a missing pandoc is a hard failure rather than a fallback.
 *
 * The runtime that owns the config installs the provisioning settings at start-up
 * ({@link setPandocProvisioning}). A caller that never sets them (this package's own unit tests, an
 * embedder using the registry with its own converter) still gets resolution through the environment
 * and the managed default directory, so the converter is usable without the engine.
 *
 * @module pandoc
 */
import { existsSync } from 'node:fs'
import { ensurePandoc, defaultToolsDir, pandocExecutable, type ProvisionLogger } from '@avantf/mem-provision'

/** What provisioning needs from the runtime that owns the config. */
export interface PandocProvisioning {
  /** Managed tools root (`tools.dir`; when nobody set one, the family root's `tools`). */
  toolsDir: string
  /** Mirror templates, tried before the official source. */
  mirror: readonly string[]
  /** `false` = never download (still resolves an existing installation). */
  autoInstall: boolean
  logger?: ProvisionLogger
}

/** The process-wide settings; the managed default until a runtime installs its own. */
let provisioning: PandocProvisioning | undefined

/** The logger used before a runtime installs one: silent, because there is nowhere to log yet. */
const silentLogger: ProvisionLogger = { info: () => undefined, warn: () => undefined, error: () => undefined }

/**
 * Install the runtime's provisioning settings (idempotent; last call wins).
 *
 * Last call wins rather than first: a process that opens two runtimes (the tests do) must have the
 * second one's tools directory take effect, otherwise a test would resolve into the first runtime's
 * home.
 */
export function setPandocProvisioning(settings: PandocProvisioning): void {
  provisioning = settings
}

/** The current settings, defaulting to the managed directory + the package's mirror defaults. */
export function pandocProvisioning(): PandocProvisioning {
  return provisioning ?? {
    // No runtime and no operator choice yet: the family root's `tools`, which is where the
    // framework installs pandoc. The pre-framework `~/.avantf/tools` is not a fallback anywhere.
    toolsDir: defaultToolsDir(),
    mirror: [],
    autoInstall: true,
  }
}

/** Clear the cached resolution — for tests, and for a caller that changed the environment. */
export function resetPandocResolution(): void {
  resolution = undefined
}

/** The resolved executable, cached because a conversion pipeline asks once per document. */
let resolution: { path: string } | undefined

/** An explicit binary path: `AVANTF_PANDOC` (the same variable provisioning honours). */
function explicitPath(): string | undefined {
  const value = process.env['AVANTF_PANDOC']
  return value === undefined || value.trim() === '' ? undefined : value.trim()
}

/**
 * The pandoc executable to run, resolving (and, when allowed, installing) on first use.
 *
 * The version pin is enforced for a MANAGED or SYSTEM candidate by the provisioning layer; an
 * explicit `AVANTF_PANDOC` is used as-is, which is the documented escape hatch for a caller that
 * wants to compare against another build.
 *
 * @throws with the provisioning layer's message (which names every source it tried and the tool's
 * per-platform install commands), so a missing pandoc never becomes "unknown format".
 */
export async function pandocBinary(): Promise<string> {
  if (resolution !== undefined) return resolution.path
  const settings = pandocProvisioning()
  const explicit = explicitPath()
  if (explicit !== undefined) {
    if (!existsSync(explicit)) {
      throw new Error(`AVANTF_PANDOC 指向的文件不存在：${explicit}`)
    }
    resolution = { path: explicit }
    return explicit
  }
  const result = await ensurePandoc({
    toolsDir: settings.toolsDir,
    config: { mirror: settings.mirror, auto_install: settings.autoInstall },
    logger: settings.logger ?? silentLogger,
  })
  if (!result.ok) throw new Error(result.error)
  resolution = { path: result.path }
  return result.path
}

/** Resolve WITHOUT installing — for a capability line in the UI or a doctor command. */
export function pandocAvailable(): { ok: true; path: string; source: string } | { ok: false; reason: string } {
  const settings = pandocProvisioning()
  const resolved = pandocExecutable(settings.toolsDir, explicitPath())
  return resolved.ok ? { ok: true, path: resolved.path, source: resolved.source } : { ok: false, reason: resolved.reason }
}
