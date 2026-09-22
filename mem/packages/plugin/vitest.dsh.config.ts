import { configDefaults, defineConfig } from 'vitest/config'
import { PEER_DEPENDENT_SPECS } from './vitest.config.js'

/**
 * The LOCAL half of the plugin's unit tests: exactly the specs that need the DSH peers at load time.
 *
 * Why a second config instead of a `--exclude` flag on the command line: the list lives once, in
 * `vitest.config.ts` (see {@link PEER_DEPENDENT_SPECS} there), and this file only inverts the
 * selection — `include` the two, drop the base's `exclude`. `mergeConfig` is deliberately NOT used:
 * it CONCATENATES arrays, so the base's `exclude` would survive and filter out the very files this
 * config is for.
 *
 * Run through `pnpm test:dsh` (the root script forwards here), which `scripts/build-plugin.mjs`
 * calls after `scripts/link-dsh.mjs` has linked the peers from the installed global dsh.
 */
export default defineConfig({
  test: {
    include: PEER_DEPENDENT_SPECS,
    exclude: configDefaults.exclude,
    env: {
      AVANTF_MEM_AUTO_DOWNLOAD: '0',
    },
  },
})
