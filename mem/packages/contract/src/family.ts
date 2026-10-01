import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * The family root and the two managed directories under it — ONE definition of a convention that
 * four packages would otherwise each spell out.
 *
 * `@avantf/dsh-plugin-base` (the family's environment framework) installs everything it manages under a
 * single root: `$AVANTF_HOME` when set, else `~/.avantf/env`. `tools` holds external binaries
 * (pandoc), `models` the downloaded embedding/rerank weights in the flat layout the transformers.js
 * cache reads. The engine's built-in defaults point HERE, not at the pre-framework
 * `~/.avantf/{tools,models}`: those legacy directories are no longer a fallback anywhere, so a
 * machine that never creates them loses nothing, and no process resolves a path that only missions
 * because somebody left a compatibility symlink behind.
 *
 * `provision` mirrors {@link familyHome} (it is deliberately dependency-free, so it cannot import
 * this module); `packages/core/test/family_paths.spec.ts` pins the two copies together so the
 * convention cannot drift.
 */
export function familyHome(env: Record<string, string | undefined> = process.env): string {
  const configured = env['AVANTF_HOME']?.trim() ?? ''
  return configured !== '' ? expandTilde(configured) : join(homedir(), '.avantf', 'env')
}

/** The managed external-binary root (`<family root>/tools`). */
export function familyToolsDir(env: Record<string, string | undefined> = process.env): string {
  return join(familyHome(env), 'tools')
}

/** The managed model-cache root (`<family root>/models`). */
export function familyModelsDir(env: Record<string, string | undefined> = process.env): string {
  return join(familyHome(env), 'models')
}

/** `~/x` → `<home>/x`, `~` → `<home>`; anything else is used as given. */
function expandTilde(path: string): string {
  if (path === '~') return homedir()
  return path.startsWith('~/') ? join(homedir(), path.slice(2)) : path
}
