/**
 * The built loader entry the base-swap proof drives.
 *
 * `scripts/prove-base-swap.mjs` looks for `lib/envinit.js` and calls `loadCompat` (or `loadEnvinit`)
 * with a SWAPPED base module, then asserts the interface-generation asymmetry: a NEWER generation is
 * accepted, an OLDER one is withheld (`undefined`) with the "shared capabilities are NOT used"
 * warning, and neither ever throws.
 *
 * It is a thin alias over {@link loadBase} rather than a second loader: mission and mem grew a large
 * envinit because they provision binaries and models, and identity has nothing to provision — the one
 * thing this tree needs from the base is the family data-home rule. Keeping the alias means the
 * proven artifact and the runtime artifact cannot drift.
 *
 * @module @avantf/dsh-identity/envinit
 */
import { loadBase, type IdentityBase, type LoadBaseOptions } from './base.js'

export type { IdentityBase, LoadBaseOptions }

/** The base loader, under the name the base-swap proof looks for. */
export function loadCompat(options: LoadBaseOptions = {}): Promise<IdentityBase | undefined> {
  return loadBase(options)
}

/** Alias kept for symmetry with the sibling trees' `loadEnvinit` entry point. */
export const loadEnvinit = loadCompat
