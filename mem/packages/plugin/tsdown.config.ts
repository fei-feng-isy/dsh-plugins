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
 * engine (`@avantf/mem-contract` → `@avantf/mem-retrieval` → `@avantf/mem`) sits in
 * `devDependencies`, so the preset's node rule — production sections stay
 * imports, everything else inlines — folds it into `lib/index.js`. The
 * production sections of the manifest are therefore the runtime surface of the
 * published package, not a workspace convenience: `yaml` /
 * `zod` stay imports, the native accelerators stay optional imports, the
 * harness stays a peer, and SQLite is the runtime's own `node:sqlite` (imported
 * by the inlined engine, so it is never a package dependency at all). Moving an engine package back into `dependencies`
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
 *
 * ── Portable client artifact (this file's own wrapper) ───────────────────────
 *
 * One artifact property is NOT provided by the pinned preset and is fixed here:
 * `lib/client.js` must be byte-identical when the same sources are built at a
 * DIFFERENT absolute directory (dev checkout vs. the projected release checkout).
 * Two preset behaviors depend on the absolute path, and they are the only two:
 *
 *   1. lightningcss's CSS Modules `pattern: '[hash]_[local]'` derives `[hash]`
 *      from the `filename` string handed to `transform()`. The preset passes the
 *      ABSOLUTE stylesheet path, so the hashed class names — and therefore the
 *      emitted CSS text and the exported class map — move with the checkout.
 *   2. The CSS virtual module id is `\0dsh-css:<absolute path>.mjs`, and Rolldown
 *      prints a module id VERBATIM in its `//#region` marker, so the artifact
 *      carries the build directory in a comment.
 *
 * Both are fixed by giving the preset's three CSS plugins a virtual id whose
 * embedded path is RELATIVE to the build's working directory. Their own `load`
 * hooks need no replacement: they slice the id and `readFile()` it (Node resolves
 * that against `process.cwd()`, which `pnpm build:dsh` sets to this directory) and
 * hand the SAME string to `transform()` as `filename`. A relative string is what
 * `[hash]` is then computed from, so it stops depending on the checkout root.
 * `basename(fileId)` — the only path component the style tag id uses — is
 * unchanged, so `styleInjectionModule`'s tag/`data-plugin-css` semantics, the
 * class-map export, `?inline` and the global-CSS variant all stay exactly as they
 * are; the wrapper's `load` additionally re-registers the physical stylesheet as
 * an ABSOLUTE watch file, so the watch graph still names the real file.
 *
 * The relative id would otherwise hide the physical stylesheet from the preset's
 * input-isolation gate (`clientInputFile` → `physicalBundleInput` returns
 * undefined for a relative id), i.e. silently drop a build-time assertion. The
 * wrapper re-asserts the SAME check, through the SAME vendored
 * `BundleInputIsolation` class and the same repository root, on the real absolute
 * path at resolve time — so coverage is preserved, not weakened.
 *
 * Finally the wrapper appends one build-time assertion to the client config: the
 * emitted chunk may not contain this checkout's absolute root, and every class-map
 * entry of every style-injection module must appear in that module's injected CSS
 * text. The rule itself lives in `mem/scripts/client-portable.mjs`, which the
 * post-build gate `mem/scripts/assert-client-portable.mjs` (wired into
 * `scripts/build-plugin.mjs`) also runs against the artifact ON DISK — one
 * definition, checked both in the bundler and after the build. Both are cheap and
 * path-independent; they are the permanent regression gate.
 *
 * The same wrapper DISABLES the preset's client sourcemap. The preset emits one so
 * browser devtools can map the fetched artifact back to TSX, but this package's
 * `files` keep `lib/client.js.map` out of the tarball (and `pack-plugin` hard-fails
 * if a map ever ships), and the built artifact IS the published one — so the map
 * was a 667 KB local-only file and the trailing `sourceMappingURL` it justified
 * 404'd in every consumer's devtools. Building without it removes both; mission's
 * esbuild client ships no sourcemap either. `clientArtifactProblems` asserts the
 * absence, so a re-enabled `sourcemap` fails the build instead of silently
 * restoring the dangling reference.
 * Byte-for-byte CROSS-DIRECTORY reproduction cannot be proven by one build, so it
 * stays a pre-release manual step:
 *
 *   cp -a <repo> /tmp/dsh-repro-a && cp -a <repo> /tmp/dsh-repro-b
 *   pnpm -C /tmp/dsh-repro-a/mem build:dsh && pnpm -C /tmp/dsh-repro-b/mem build:dsh
 *   sha256sum /tmp/dsh-repro-{a,b}/mem/packages/plugin/lib/client.js   # identical
 */
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { clientArtifactProblems } from '../../scripts/client-portable.mjs'

interface HarnessClientPreset {
  /** Returns the build-face function tsdown calls with its own inline config (see the preset's `{ env }`). */
  clientBundle: (id: string, entries: string[]) => (inlineConfig: TsdownInlineConfig) => unknown
}

/** The slice of tsdown's inline config the preset reads (`env.DSH_BUILD_FACE`). */
interface TsdownInlineConfig {
  env?: Record<string, string | undefined>
}

/** The slice of the vendored input-isolation module the wrapper re-asserts with. */
interface BundleInputIsolationModule {
  BundleInputIsolation: new (repository: string, label: string) => { assertInput(id: string): void }
}

/** A tsdown/rolldown plugin object, as far as this wrapper inspects it. */
interface WrappablePlugin {
  readonly name?: unknown
  readonly resolveId?: unknown
  readonly load?: unknown
}

/** The slice of the loader context the wrapper touches. */
interface LoaderContext {
  addWatchFile(id: string): void
}

/** A tsdown config object, as far as this wrapper rewrites it. */
interface WrappableConfig {
  readonly plugins?: unknown
  readonly sourcemap?: boolean
}

/** The virtual-id prefixes the preset's three CSS loaders prepend. */
const CSS_VIRTUAL_PREFIXES = ['\0dsh-css:', '\0dsh-global-css:', '\0dsh-inline-css:']
const CSS_VIRTUAL_SUFFIX = '.mjs'
/** The plugin names whose `resolveId` builds those virtual ids. */
const CSS_PLUGIN_NAMES = new Set(['dsh-css-modules-inline', 'dsh-css-text-inline', 'dsh-css-global-inline'])

/** This file's directory: the plugin package, and the cwd `pnpm build:dsh` gives tsdown. */
const PLUGIN_DIR = fileURLToPath(new URL('.', import.meta.url))
/** The `mem/` tree root and the workspace root, for the build-root leak assertion. */
const TREE_ROOT = resolve(PLUGIN_DIR, '..', '..')
const WORKSPACE_ROOT = resolve(TREE_ROOT, '..')

/** The virtual id's prefix when `virtualId` is one of the three stylesheet loaders, or undefined. */
function cssVirtualPrefix(virtualId: string): string | undefined {
  if (!virtualId.endsWith(CSS_VIRTUAL_SUFFIX)) return undefined
  return CSS_VIRTUAL_PREFIXES.find((prefix) => virtualId.startsWith(prefix))
}

/** The physical path embedded in a stylesheet virtual id. */
function embeddedStylesheet(virtualId: string): string | undefined {
  const prefix = cssVirtualPrefix(virtualId)
  return prefix === undefined ? undefined : virtualId.slice(prefix.length, -CSS_VIRTUAL_SUFFIX.length)
}

/**
 * Rewrite a stylesheet virtual id so its embedded path is relative to `base` (the
 * build cwd) instead of absolute. A non-stylesheet id, or one whose embedded path
 * is not absolute, is returned untouched.
 */
function relativeStylesheetId(virtualId: string, base: string): string {
  const prefix = cssVirtualPrefix(virtualId)
  if (prefix === undefined) return virtualId
  const physical = virtualId.slice(prefix.length, -CSS_VIRTUAL_SUFFIX.length)
  if (!isAbsolute(physical)) return virtualId
  return prefix + relative(base, physical).split(sep).join('/') + CSS_VIRTUAL_SUFFIX
}

/**
 * Wrap the CSS plugins of one config. `resolveId` keeps its shape but the path
 * embedded in its virtual id becomes cwd-relative, and the physical file it named
 * is asserted against the preset's own input-isolation rules before that (the
 * preset's generateBundle can no longer recover a physical path from a relative
 * id). `load` is left in place — it reads the same relative path back through the
 * cwd — except that the physical stylesheet is also registered as an absolute
 * watch file, so the watch graph names exactly the file it did before.
 */
function portablePlugins(
  plugins: unknown,
  isolation: { assertInput(id: string): void },
  base: string,
): unknown {
  if (!Array.isArray(plugins)) return plugins
  return plugins.map((plugin) => {
    if (Array.isArray(plugin)) return portablePlugins(plugin, isolation, base)
    if (plugin === null || typeof plugin !== 'object') return plugin
    const candidate = plugin as WrappablePlugin
    if (typeof candidate.name !== 'string' || !CSS_PLUGIN_NAMES.has(candidate.name)) return plugin
    if (typeof candidate.resolveId !== 'function') return plugin
    const originalResolveId = candidate.resolveId as (source: string, importer?: string) => unknown
    const originalLoad = typeof candidate.load === 'function'
      ? candidate.load as (this: LoaderContext, id: string) => unknown
      : undefined
    const wrapped: Record<string, unknown> = {
      ...(plugin as Record<string, unknown>),
      resolveId(this: unknown, source: string, importer?: string): unknown {
        const virtualId = originalResolveId.call(this, source, importer)
        if (typeof virtualId !== 'string') return virtualId
        const physical = embeddedStylesheet(virtualId)
        if (physical !== undefined && isAbsolute(physical)) isolation.assertInput(physical)
        return relativeStylesheetId(virtualId, base)
      },
    }
    if (originalLoad !== undefined) {
      wrapped.load = function load(this: LoaderContext, virtualId: string): unknown {
        const physical = embeddedStylesheet(virtualId)
        if (physical !== undefined && !isAbsolute(physical)) this.addWatchFile(resolve(base, physical))
        return originalLoad.call(this, virtualId)
      }
    }
    return wrapped
  })
}

/**
 * The plugin that enforces {@link clientArtifactProblems} on the emitted client
 * chunk. The rule itself lives in `mem/scripts/client-portable.mjs` so the
 * post-build gate (`scripts/assert-client-portable.mjs`, wired into
 * `scripts/build-plugin.mjs`) checks the on-disk artifact with the SAME code.
 */
function artifactAssertionPlugin(): unknown {
  return {
    name: 'dsh-client-artifact-portable',
    writeBundle(
      _options: unknown,
      bundle: Record<string, { readonly type?: unknown, readonly code?: unknown }>,
    ): void {
      const problems: string[] = []
      for (const output of Object.values(bundle)) {
        if (output?.type === 'chunk' && typeof output.code === 'string') {
          problems.push(...clientArtifactProblems(output.code, [WORKSPACE_ROOT, TREE_ROOT]))
        }
      }
      if (problems.length > 0) {
        throw new Error(`client artifact portability (@avantf/dsh-mem): ${[...new Set(problems)].join('; ')}`)
      }
    },
  }
}

/**
 * Wrap one config: make the CSS virtual ids path-relative, append the artifact
 * assertion to the client config, and drop the client sourcemap (see the file
 * header — the map is never published, so neither it nor its reference belongs in
 * the artifact).
 */
function portableConfig(
  config: WrappableConfig,
  isolation: { assertInput(id: string): void },
  base: string,
): WrappableConfig {
  if (!Array.isArray(config.plugins)) return config
  const plugins = portablePlugins(config.plugins, isolation, base)
  const isClient = Array.isArray(plugins) && plugins.some((plugin) => {
    const name = (plugin as WrappablePlugin | null)?.name
    return typeof name === 'string' && CSS_PLUGIN_NAMES.has(name)
  })
  return isClient && Array.isArray(plugins)
    ? { ...config, sourcemap: false, plugins: [...plugins, artifactAssertionPlugin()] }
    : { ...config, plugins }
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
  const { BundleInputIsolation } = (
    await import('./vendor/dsh-client-preset/scripts/bundle-input-isolation.ts')
  ) as BundleInputIsolationModule
  // The build cwd is the base for both halves of the fix, and it is also what the
  // preset's own `readFile(fileId)` resolves against — so the relative id it now
  // receives always reads back the file it named. `pnpm build:dsh` guarantees it
  // by running tsdown with `-c packages/plugin`.
  const base = process.cwd()
  const isolation = new BundleInputIsolation(
    fileURLToPath(new URL('./vendor/dsh-client-preset', import.meta.url)),
    'client bundle isolation (@avantf/dsh-mem)',
  )
  const configs = clientBundle('@avantf/dsh-mem', ['lib/types/index.js'])(inlineConfig)
  if (!Array.isArray(configs)) return configs
  return (configs as WrappableConfig[]).map((config) => portableConfig(config, isolation, base))
}
