# Vendored DSH client tsdown preset

This directory is a **verbatim, pinned copy** of the deepseek-harness client bundle
preset — the code `packages/plugin/tsdown.config.ts` used to `import()` out of a
harness source checkout. `pnpm build:dsh` / `pnpm release:check` now always load
THIS copy, so compiling, type-checking and mounting need **no harness source
checkout** on the machine: only the installed `dsh` (its `@deepseek-ai/*` peers)
and npm packages. A checkout, when one happens to be present, is used only by
`scripts/check-preset-drift.mjs` to cross-check that this pin has not drifted.

## Origin

| | |
|---|---|
| repository | `https://github.com/deepseek-ai/deepseek-harness` |
| revision | `ddefc45fbc7f8e46dd73185e68295696d1297887` (`ddefc45fbc`, "Merge pull request #4469 … release-dsh-0.1.6-alpha.2") |
| commit date | `2026-09-17T21:19:19+08:00` |
| `packages/client/tsdown.client.ts` mtime | `2026-09-18 15:24:11.481286945 +0800` |
| copied | verbatim with `cp -p`; every file byte-identical (`cmp`) to its origin |

## Layout

This directory is a mini replica of the harness repository root: `packages/client/`
mirrors harness `packages/client/`, `scripts/` mirrors harness `scripts/`. That depth
is load-bearing twice over:

- the preset's own relative imports (`./modules/src/client/manifest.ts`,
  `./web/src/platform.ts`, `../../scripts/client-build-environment.ts`,
  `../../scripts/bundle-input-isolation.ts`) resolve unchanged;
- the preset's `REPOSITORY_ROOT = fileURLToPath(new URL('../..', import.meta.url))`
  becomes this directory, so its manifest glob `packages/*/*/package.json` finds the
  stub `link-dsh.mjs` publishes at `packages/client/avantf-dsh-mem/package.json`.

**Do not rewrite a single line** — see "Why the whole closure" below. (A flatter
layout that put `tsdown.client.ts` directly under `client/` would break both: `../..`
would land on `vendor/`, and `../../scripts/...` would look for `vendor/scripts/`.)

| vendored path | harness path | lines | sha256 |
|---|---|---|---|
| `packages/client/tsdown.client.ts` | `packages/client/tsdown.client.ts` | 735 | `6ba0fe90e6bf259ea7b3b76a6dd294eceab1c599a1cbaa2c470157c6253326e2` |
| `packages/client/modules/src/client/manifest.ts` | `packages/client/modules/src/client/manifest.ts` | 436 | `cf144b467b4f5b7c8faef012821508dc0ba7cb694d9558673599734a996484c8` |
| `packages/client/modules/src/client/system.ts` | `packages/client/modules/src/client/system.ts` | 377 | `0bf04fefa0c7a977e96439e3fb1dcddb05b42e9d13e7aa3f649f4adfc6cad5a5` |
| `packages/client/modules/src/client/entries.ts` | `packages/client/modules/src/client/entries.ts` | 247 | `52b438c9541a470b63e41b8880fd608909117168bfcd76cbe65be6dbff651edc` |
| `packages/client/modules/src/client/entry-lifecycle.ts` | `packages/client/modules/src/client/entry-lifecycle.ts` | 28 | `1b6f54b4fbebf5c440e753b9c104d4741e632b744b496a6a23af6f8fc20cc198` |
| `packages/client/web/src/platform.ts` | `packages/client/web/src/platform.ts` | 21 | `72e7a9bf2187a8a79c3871cddaa067afc25b5c2d28abb7373e6a8113122413ac` |
| `scripts/client-build-environment.ts` | `scripts/client-build-environment.ts` | 395 | `064ee73384745e7b327c8465fb31b0b99cce5b3824363cdac9eb455ff17b4bb8` |
| `scripts/bundle-input-isolation.ts` | `scripts/bundle-input-isolation.ts` | 95 | `8aefbe91d41896534b331934d3176ab91138efdf8ca6bfacfb769144f17e6d0d` |

Total: 8 files / 2334 lines.

## Why the whole closure, not a trimmed copy

- It is **harness build-internal code**, not a published package. `packages/client/`
  has no `package.json`, and `@deepseek-ai/dsh-client-modules` publishes only
  `lib/**` with no `./tsdown` export — so there is no npm road to the preset.
- The **manifest mechanism** decides artifact shape: `clientBundle(id, …)` looks the
  package manifest up by name via `globSync('packages/*/*/package.json', { cwd:
  REPOSITORY_ROOT })` (`REPOSITORY_ROOT = new URL('../..', import.meta.url)`), and the
  node half's `neverBundle` / `alwaysBundle` rules are computed from that manifest's
  production sections. `scripts/link-dsh.mjs` therefore publishes a stub
  `packages/client/avantf-dsh-mem/package.json` (a symlink to
  `packages/plugin/package.json`) inside whichever preset root is in use.
- `lightningcss` participates in emitted CSS bytes (`transform(...)` in the preset's
  CSS loaders), and the face protocol (`env.DSH_BUILD_FACE`) decides which halves a
  single tsdown invocation emits. Trimming or "simplifying" any of this silently
  changes what ships to the browser, which has no automated coverage (the mount smoke
  only exercises the host half).
- The only non-Node-builtin runtime dependency in the closure is `lightningcss`; every
  other bare import is `import type` (`@deepseek-ai/cordis`,
  `dsh-package-manifest`, `cordis-plugin-loader`, `dsh-client-store`) and is erased at
  load time. It is declared as a devDependency of `packages/plugin` via the
  `pnpm-workspace.yaml` catalog (harness pins `^1.32.0`).

## Re-aligning with a newer harness checkout

`scripts/check-preset-drift.mjs` compares all 8 files here against the checkout (when
one is discoverable) and prints a warning naming the file and both sides. To re-align:

1. Find the harness revision whose `packages/client/tsdown.client.ts` you mean to pin
   (`git -C <harness> rev-parse HEAD`).
2. Recompute the relative closure from `packages/client/tsdown.client.ts` (BFS over
   relative `import`s). If it grew or shrank, update this file's layout/table too.
3. Re-copy verbatim: `cp -p` each file to its mirrored path here.
4. Update this ORIGIN.md: revision, dates, per-file line counts and sha256.
5. **Re-run the byte-equivalence proof** (`scripts/check-preset-drift.mjs` prints the
   command): build `lib/index.js` + `lib/client.js` once through the harness checkout
   preset and once through this copy, and require the two sha256 pairs to be equal.
   A behavioural change in the preset must ship together with a re-verified artifact
   comparison, never on "it still builds".
