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
 *    text: `memory/`, `knowledge/`, `configs/*.yaml`, `prompts/*.md`. Precedence is an explicit caller
 *    value (⑤) → `$AVANTF_HOME` (④) → the configured `dataHome` (②) → `~/.avantf`.
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
 * The input to {@link resolveDataHome}: every value in a NAMED slot, never a position.
 *
 * The slots are the family's layers, and their meanings ARE the contract:
 *
 *  - `explicit` — layer ⑤, a caller's own value (the CLI's `--data-home`);
 *  - `env` — layer ④, the environment map `$AVANTF_HOME` is read from; defaults to `process.env`;
 *  - `configured` — layer ②, the resolved `common.dataHome` from configuration.
 *
 * The named shape is not decoration. Both implementations used to take three POSITIONAL arguments and
 * disagreed about their order (this kit read `(explicit, env, common)`, the mem engine
 * `(common, explicit)`), so "which slot does the profile's `dataHome` belong in?" — the one question
 * that decides where the user's memory, knowledge and prompts live — was answerable only by reading
 * the call site's argument order. `common.dataHome` carries a schema default and therefore ALWAYS
 * holds a value: in the `explicit` slot it promotes layer ② above layer ④ and silently kills
 * `$AVANTF_HOME` on that side of the family, which is how the same config came to resolve to two
 * different directories. A named object makes that a type error instead of a diff nobody reads.
 *
 * This shape is the base interface type's `dataHomeInput` member; the two must stay identical.
 */
export interface DataHomeInput {
  /** Layer ⑤: an explicit caller value; blank or omitted means "not given". */
  readonly explicit?: string
  /** Layer ④: the environment map; defaults to `process.env`. */
  readonly env?: Record<string, string | undefined>
  /** Layer ②: the configured `common.dataHome`; blank or omitted means "not configured". */
  readonly configured?: string
}

/**
 * The data root: an explicit caller value (⑤) → `$AVANTF_HOME` (④) → the configured
 * `common.dataHome` (②) → `~/.avantf`. That is the family's layer order (`mem/AGENTS.md`
 * 「配置分层」: built-in → common.yaml → store → ENV → explicit), so the environment wins over the
 * config file and an explicit argument wins over both.
 *
 * The configured value is a NAMED slot ({@link DataHomeInput}) for the reason recorded there: it
 * always holds a value, so a positional API let a caller hand it to the `explicit` slot and make
 * `$AVANTF_HOME` dead on one side of the family. The two implementations (this kit and
 * `@avantf/mem-contract`) are pinned to the same answer by
 * `mem/packages/plugin/test/family_pin.spec.ts`.
 *
 * `~/` (and a bare `~`) is expanded here so every caller agrees on one directory.
 */
export function resolveDataHome(input: DataHomeInput = {}): string {
  const layer5 = input.explicit?.trim() ?? ''
  const env = input.env ?? process.env
  const fromEnv = env['AVANTF_HOME']?.trim() ?? ''
  const layer2 = input.configured?.trim() ?? ''
  const base = layer5 !== '' ? layer5 : fromEnv !== '' ? fromEnv : layer2 !== '' ? layer2 : '~/.avantf'
  return expandHome(base)
}
