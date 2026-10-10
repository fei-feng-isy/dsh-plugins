/**
 * Packages released in lockstep with dsh, so their version says which dsh this build was made for.
 *
 * This must list every `@deepseek-ai/dsh-*` entry `scripts/link-dsh.mjs` bakes into
 * `lib/dsh-build.json`, not just the ones the plugin imports at runtime: `scripts/lib/pack-plugin.mjs`
 * fails the release in BOTH directions (a listed package that is not baked, and a baked package that
 * is not listed), because a missing entry would make the compatibility gate fall back to the peer
 * range's floor — a lower bound the artifact tolerates, which says nothing about the dsh `tsc` actually
 * compiled against.
 *
 * Identity imports `dsh-system-prompt` (the mechanism and `PERSONA_PREFIX_SECTION`) and
 * `dsh-typert-protocol` (the Remote face) at runtime; `dsh-scope` is the mechanism spec's
 * `createScope`, and `dsh-tools` is linked only because the release gate requires a baked version for
 * it. A version mismatch is a WARNING, never a refusal: only a PROVEN host break refuses a mount.
 *
 * @module @avantf/dsh-identity/versions
 */

export const VERSION_PACKAGES: readonly string[] = [
  '@deepseek-ai/dsh-scope',
  '@deepseek-ai/dsh-system-prompt',
  '@deepseek-ai/dsh-tools',
  '@deepseek-ai/dsh-typert-protocol',
]
