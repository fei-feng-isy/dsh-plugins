import { configDefaults, defineConfig } from 'vitest/config'

/**
 * Plugin-side unit tests.
 *
 * They must stay free of `@deepseek-ai/*` (and of `src/index.ts`, which imports
 * those peers): the peers resolve only inside the DSH harness checkout or an
 * installed `dsh`, so a test that pulls them in could not run in CI. What is worth
 * testing here is harness-independent anyway — the zod → DSH parameter derivation
 * and the client/host envelope decoding.
 *
 * {@link PEER_DEPENDENT_SPECS} is the exception, and this constant is the ONE place that knows it:
 * both specs import `src/provision.ts`, whose `defineTool` is a VALUE import of
 * `@deepseek-ai/dsh-tools` — in a tree without the linked peers (which is what CI is: no
 * `@deepseek-ai/*` in the lockfile, `autoInstallPeers: false`, and `scripts/link-dsh.mjs` runs only
 * locally) vitest cannot even LOAD them, so the whole `pnpm test` step fails. They are excluded
 * here (the CI run is then exactly what the CI note and `docs/RELEASING.md` §1 claim: the
 * harness-free units) and included only by `vitest.dsh.config.ts` (`pnpm test:dsh`, which
 * `scripts/build-plugin.mjs` calls after the peers are linked).
 *
 * Do not add a spec here to make a failure disappear: a new spec that needs a peer belongs in the
 * same LOCAL run as these two, and a `src/*.ts` that only *type*-imports a peer stays CI-safe
 * (erased at transpile) — the line is drawn at value imports.
 */
export const PEER_DEPENDENT_SPECS = ['test/provision.spec.ts', 'test/envinit.spec.ts']

export default defineConfig({
  test: {
    exclude: [...configDefaults.exclude, ...PEER_DEPENDENT_SPECS],
    env: {
      // No model, no network — nothing in this package warms a model, but keep the
      // kill switch in place so an accidental engine import cannot download.
      AVANTF_MEM_AUTO_DOWNLOAD: '0',
    },
  },
})
