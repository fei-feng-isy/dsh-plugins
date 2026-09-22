/**
 * DSH client bundle for `@avantf/dsh-mem`.
 *
 * `clientBundle` emits both faces: the Node half (`lib/index.js`) and the
 * browser half (`lib/client.js`, a `window.__ModuleLoader__.load({id, factory})`
 * CJS factory whose `require` resolves platform modules such as `react` from the
 * module table). The preset reads its package manifest by globbing
 * `<preset root>/packages/*\/*\/package.json`, so `scripts/link-dsh.mjs`
 * publishes a stub row (`packages/client/avantf-dsh-mem/package.json` → this
 * plugin's manifest) under the preset root. Run tsdown against this config with
 * the plugin directory as the working directory (see `pnpm build:dsh`).
 *
 * The Node half IS the published artifact, and it ships as ONE package: the
 * engine (`@avantf/mem-contract` → `@avantf/mem-core` → `@avantf/mem`) sits in
 * `devDependencies`, so the preset's node rule — production sections stay
 * imports, everything else inlines — folds it into `lib/index.js`. The
 * production sections of the manifest are therefore the runtime surface of the
 * published package, not a workspace convenience: `better-sqlite3` / `yaml` /
 * `zod` stay imports, the native accelerators stay optional imports, the
 * harness stays a peer. Moving an engine package back into `dependencies`
 * silently un-inlines it and ships a package that cannot resolve `@avantf/*`
 * on a user's machine; `pnpm pack:plugin` asserts the artifact is
 * self-contained, so run it after touching this file or the manifest.
 *
 * The preset is the **pinned copy in this repository**:
 * `packages/plugin/vendor/dsh-client-preset/`, a verbatim copy of the harness
 * client bundle preset (origin and re-alignment steps in its `ORIGIN.md`). It is
 * imported by a literal relative specifier — never resolved through a harness
 * source checkout, and never selected by an environment variable — so
 * `pnpm build:dsh` compiles, type-checks and mounts with only the INSTALLED dsh
 * and this repository present. `scripts/check-preset-drift.mjs` optionally
 * compares the pin against a checkout when one happens to be on the machine.
 *
 * The startup compatibility gate needs no build-time constant from THIS file. The
 * version a build was compiled against is baked next to the built entry as a plain
 * JSON (`scripts/build-versions.mjs` → `lib/dsh-build.json`), read at startup by
 * the base's `readBuildVersions()` from `src/provision.ts`; the package
 * manifest's peer range floor is the per-package fallback. A tsdown `define` would
 * only serve the bundled node half, so the JSON is what keeps the two faces on the
 * same mechanism — and `files: ["lib"]` ships it with the package.
 */
interface HarnessClientPreset {
  /** Returns the build-face function tsdown calls with its own inline config (see the preset's `{ env }`). */
  clientBundle: (id: string, entries: string[]) => (inlineConfig: TsdownInlineConfig) => unknown
}

/** The slice of tsdown's inline config the preset reads (`env.DSH_BUILD_FACE`). */
interface TsdownInlineConfig {
  env?: Record<string, string | undefined>
}

/**
 * tsdown calls a top-level function export ONCE and rejects a function nested in
 * its return value, so this wrapper must invoke the preset's own function with
 * the inline config it was handed — forwarding, never re-deriving it.
 */
export default async (inlineConfig: TsdownInlineConfig) => {
  const { clientBundle } = (
    await import('./vendor/dsh-client-preset/packages/client/tsdown.client.ts')
  ) as HarnessClientPreset
  return clientBundle('@avantf/dsh-mem', ['lib/types/index.js'])(inlineConfig)
}
