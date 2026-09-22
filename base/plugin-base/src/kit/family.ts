/**
 * The family's path conventions — ONE definition of two directories that four modules used to spell
 * out independently (`@avantf/mem-contract`, `@avantf/mem-provision`, `@avantf/mem`'s config paths
 * and the work plugin's prompt layer). They are part of the kit because a change to either convention
 * must be fixable with one base release.
 *
 * TWO ROOTS, and they are deliberately different. Confusing them is the bug this module documents:
 *
 *  - the **family root** (`familyHome`) is where the environment framework installs what it manages:
 *    `$AVANTF_HOME` when set, else `~/.avantf/env`. Tools live in `<family root>/tools`, model
 *    weights in `<family root>/models`.
 *  - the **data root** (`resolveDataHome`) is where a plugin keeps the user's OWN data and editable
 *    text: `memory/`, `knowledge/`, `configs/*.yaml`, `prompts/*.md`. Precedence is an explicit
 *    value (a resolved `common.dataHome`) → `$AVANTF_HOME` → `~/.avantf`.
 *
 * Setting `$AVANTF_HOME` therefore redirects BOTH a deployment's data and its managed resources under
 * one prefix — which is what a sandbox or a test needs — while the unset default keeps them apart
 * (`~/.avantf` for data, `~/.avantf/env` for resources).
 *
 * @module @avantf/dsh-plugin-base/kit/family
 */
import { homedir } from 'node:os'
import { join } from 'node:path'

/** `~/x` → `<home>/x`, `~` → `<home>`; anything else is used as given. */
export function expandHome(path: string, home: string = homedir()): string {
  if (path === '~') return home
  return path.startsWith('~/') ? join(home, path.slice(2)) : path
}

/** The family root: `$AVANTF_HOME` when set, else `~/.avantf/env`. */
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

/**
 * The data root: an explicit value (the resolved `common.dataHome`) → `$AVANTF_HOME` → `~/.avantf`.
 * `~/` is expanded here so every caller agrees on one directory.
 */
export function resolveDataHome(
  explicit?: string,
  env: Record<string, string | undefined> = process.env,
): string {
  const configured = explicit?.trim() ?? ''
  const fromEnv = env['AVANTF_HOME']?.trim() ?? ''
  const base = configured !== '' ? configured : fromEnv !== '' ? fromEnv : '~/.avantf'
  return expandHome(base)
}
