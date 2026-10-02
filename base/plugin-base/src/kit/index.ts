/**
 * The shared KIT: pure, DSH-free helpers used by the family's DSH plugins.
 *
 * This is NOT a package. It is a source area INSIDE the one published base package
 * (`@avantf/dsh-plugin-base`), and that is the whole point: fixing or extending a shared helper must
 * be possible with ONE base release, without rebuilding or republishing any plugin. Plugins
 * therefore never inline this code — they load the base at startup through the inlined bootstrap
 * (the only vendored piece) and take these capabilities off the loaded module at runtime:
 *
 *  - prompt file reading/writing (`PromptFiles`),
 *  - the plugin logger (`createPluginLogger`),
 *  - the family path conventions (`familyHome` / `familyToolsDir` / `familyModelsDir` /
 *    `resolveDataHome` / `expandHome`),
 *  - the Typert wire conventions (`strictCodec` / endpoint and field symbols),
 *  - well-formed text (`wellFormedText` / `wellFormedDeep`): the lone-surrogate repair every
 *    model-visible boundary needs, with a local fallback for engines without
 *    `String.prototype.toWellFormed`.
 *
 * When the base is unavailable, every consumer degrades instead of failing: the prompt layer falls
 * back to the plugin's OWN built-in default bodies, the compatibility gate logs its `compat:`
 * WARNING and is skipped, and the plugin mounts in full. See the root `AGENTS.md`.
 *
 * @module @avantf/dsh-plugin-base/kit
 */
export * from './prompt_files.js'
export * from './logger.js'
export * from './typert.js'
export * from './family.js'
export * from './wellformed.js'
