import { homedir } from 'node:os'
import { join } from 'node:path'
import { expandHome } from './env.js'

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
 *
 * The `~/` expansion is NOT a private copy any more: this module and `env.ts` used to carry two
 * literally identical `expandTilde`/`expandHome` bodies in the same package, and only the exported
 * one was pinned — so the un-pinned copy could drift silently. It now calls {@link expandHome}.
 */
export function familyHome(env: Record<string, string | undefined> = process.env): string {
  const configured = env['AVANTF_HOME']?.trim() ?? ''
  return configured !== '' ? expandHome(configured) : join(homedir(), '.avantf', 'env')
}

/** The managed external-binary root (`<family root>/tools`). */
export function familyToolsDir(env: Record<string, string | undefined> = process.env): string {
  return join(familyHome(env), 'tools')
}

/** The managed model-cache root (`<family root>/models`). */
export function familyModelsDir(env: Record<string, string | undefined> = process.env): string {
  return join(familyHome(env), 'models')
}
