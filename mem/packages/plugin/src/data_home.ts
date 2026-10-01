/**
 * The plugin's data root, resolved through the FAMILY's layers.
 *
 * The profile's `config.dataHome` is CONFIGURATION, so it takes the CONFIGURED layer: ⑤ an explicit
 * caller value → ④ `$AVANTF_HOME` → ② this configured value → `~/.avantf`. Handing it straight to the
 * engine's explicit slot instead — which is what this plugin used to do — promotes ② above ④, and the
 * same profile then resolves to two different directories depending on which half of the family reads
 * it: the mission plugin resolves the same knob through its configured layer, so with `$AVANTF_HOME` set
 * mission read `<env>/prompts` while this plugin read `<config>/prompts`. That directory is SHARED (both
 * plugins' editable prompt files live in it), so "the file you edited is read by one plugin and not
 * the other" is a real failure, not a nuance. `AGENTS.md` 「边界与路径」 states the rule this
 * implements: the configured value travels in the config layer, never in the explicit one.
 *
 * The engine's own copy of the rule does the mission (it is the one the CLI and MCP resolve with, and
 * `test/family_pin.spec.ts` pins it against the base kit's). This module exists so the plugin's USE of
 * it is testable without the DSH harness: the entry module imports `@deepseek-ai/*` at load, which
 * resolves only inside a harness workspace.
 *
 * @module data_home
 */
import { resolveDataHome } from '@avantf/mem'

/** Layer ② for the configured value; `$AVANTF_HOME` (④) and any explicit value (⑤) still outrank it. */
export function configDataHome(configured: string | undefined): string {
  return resolveDataHome({ common: { dataHome: configured ?? '' } })
}
