# AGENTS.md — the merged `dsh-plugins` workspace

`base/`, `mem/` and `work/` are ONE repository. They used to be four (`dsh-envinit`, `dsh-compat`,
`avantf-mem`, `avantf-work`); this file states what the merge guarantees and what a change here must
not break. Each subtree keeps its own `AGENTS.md`/`DESIGN.md` for its own domain — read this one first.

## The publish surface: exactly three packages

| directory | package | what it is |
| --- | --- | --- |
| `base/plugin-base` | `@avantf/dsh-plugin-base` | envinit (startup environment initialisation) **+** the host compatibility gate **+** the shared kit — ONE package, ONE release |
| `mem/packages/plugin` | `@avantf/dsh-mem` | the memory/knowledge DSH plugin |
| `work/packages/plugin` | `@avantf/dsh-work` | the work-tree DSH plugin |

Every other workspace package (`@avantf/mem-*`, `@avantf/work-core`, the CLI/MCP) is `private: true`
and is inlined into the plugin that uses it. `scripts/release-check.mjs` fails if the publishable set
is anything other than those three.

- The **old** packages `@avantf/dsh-envinit` and `@avantf/dsh-compat` are dead: their code lives in
  the base, they receive no new versions, and nothing may name them.
- A plugin depends on the base as a **REQUIRED peer** with a range wide enough to take a base patch or
  minor release (`^0.1.0`). It also declares the same base in `devDependencies` (`^0.1.3`) so
  `pnpm install` gives the build something to resolve; `linkWorkspacePackages: true` in the root
  `pnpm-workspace.yaml` makes that a link to `base/`, never a download.
- The host/profile installs `@avantf/dsh-plugin-base` **and** the two plugins explicitly
  (`autoInstallPeers: false`). An npm-style installer that auto-installs peers gets the base
  automatically.
- **`zod` resolves exactly once.** One root `catalog: zod: 4.6.5` (the version the installed dsh
  ships). The base's own peer stays `>=4.4.3 <5`, so the same base serves this workspace and the
  host's 4.6.5. Bump the catalog line, never a `package.json`.
- **Publish order: base → plugins.** A plugin's required peer must already exist on the registry;
  `scripts/release-check.mjs` asserts a published base version inside each plugin's peer range (use
  `--allow-missing-base` only for a pre-publication dry run). No tarball may carry a `link:`/`file:`
  specifier.

## The three family hard constraints

1. **Provisioned code is never bundled and never statically imported.** A plugin's only static
   reference to the base is the zero-dependency bootstrap vendored into
   `packages/plugin/src/envinit-bootstrap.js` and INLINED into the bundle. A static
   `import ... from '@avantf/dsh-plugin-base'` — or a literal dynamic `import('@avantf/dsh-plugin-base')`
   — would make the plugin module fail to load whenever the base is absent, which is exactly the
   failure a plugin must never have.
2. **The base is provided by the framework/host and loaded dynamically by file URL.** At startup the
   inlined bootstrap resolves it with
   `createRequire(import.meta.url).resolve('@avantf/dsh-plugin-base/package.json')` and `import()`s the
   result, then checks the version against the inlined `supportedRange`. Absent or out-of-range → one
   `envinit: WARNING` and the plugin mounts anyway.
3. **Publishing is ordered and path-free.** base first, then the plugins; `link:`/`file:` never appears
   in a published manifest.

## The one judgement rule: can ONE base release fix this?

Every time you decide whether a piece of knowledge goes into `base/` (consumed at runtime) or stays in
a plugin, ask exactly this: **"must this knowledge be fixable by one base release?"**

- **Yes → the base owns it and the plugin takes it off the loaded base module at RUNTIME.** This is why
  the kit is not a private package and plugins must not inline it. Runtime-from-base today:
  - the compatibility gate: rules, probes, verdict, report, post-registration verification
    (`runtimeFromCompat(framework)`),
  - the envinit provisioner: `createProvisioner`, the three provider factories,
    `ITEM_SCHEMA_VERSION` and the item kinds,
  - the prompt-file layer `PromptFiles` (both plugins construct `kit.PromptFiles` off the loaded base).
- **A deliberate mirror, pinned by a test.** Family/data path resolution has TWO copies and must keep
  both: `base/plugin-base/src/kit/family.ts` is the canonical one and work's `promptDir` takes
  `kit.resolveDataHome` off the loaded base, while `@avantf/mem-contract`'s `family.ts` keeps its own
  dependency-free copy because the CLI and MCP server have no DSH host and never load the base. A test
  pins the copies together. This is the ONE place "a single base release is enough" does not hold —
  changing the convention is a base release **and** a mem-engine change — and it is deliberate: the
  base-less paths must work.
- **No → it may stay in the plugin, but say so here and accept that changing it needs a plugin
  release.** The documented plugin-local knowledge:
  - the Typert `strict` codec envelope and the `<pkg>#<namespace>/<method>:<field>` type-symbol
    helpers (`mem/packages/plugin/src/remote.ts`, `work/packages/plugin/src/wire.ts`). They are a few
    lines mirroring the generator's convention and are assembled at module load; the descriptor
    assembly genuinely differs per plugin (work adds `stream`/cancellation; mem has an
    `acceptsUndefined` parameter helper). **The base kit also exposes `strictCodec` / `endpointId` /
    `fieldSymbol` / `resultSymbol` as the canonical copies, so a plugin MAY take them off the loaded
    module — but today these two keep their own, and changing THEM needs a plugin release.**
  - the plugin logger,
  - each plugin's compat SPEC and envinit item list: which services/methods it calls, which dsh
    packages identify the host, its wire schema names, its events, its Chinese report strings, and its
    `mem:pandoc` / `mem:model` / `work:*` items. Only that plugin knows them.
  - each plugin's built-in default prompt bodies and its client/UI half, and the base-less fallbacks
    (the `resolveDataHome` default parameter in work's `prompt.ts`, the default section texts in mem's
    `prompt.ts`). A fallback is not a second implementation of record: it only runs when the base is
    absent.

## Degradation when the base is missing (never a refusal)

| capability | base absent |
| --- | --- |
| prompt-file layer | the plugin uses its OWN built-in default bodies (its content, not a copy of the kit) |
| compatibility gate | a `compat:` WARNING, the gate is skipped. Judgement semantics never change: only a PROVEN incompatibility refuses the mount, "cannot tell" is a note, a version difference is only a warning, nothing throws |
| resource provisioning (pandoc/model) | the legacy `@avantf/mem-provision` / legacy-tools-dir path |
| tools, service, Remote, UI faces | unaffected — the plugin mounts in full |

## Gates to run

| command | what it proves |
| --- | --- |
| `pnpm guard` (`scripts/boundary-guard.mjs`) | `mem/` and `work/` never import each other (or a relative path into the other half); only base and each half's own packages are reachable. `base/plugin-base/test/boundary.spec.ts` is the authoritative vitest mirror — change BOTH when a rule changes |
| `pnpm release:check` (`scripts/release-check.mjs`) | publishable set is exactly the three, the others private; peer ranges are required and wide enough; base peer zod `>=4.4.3 <5`; `catalog.zod` 4.6.5; no `link:`/`file:`; the registry already carries a compatible base |
| `pnpm proof:base-swap` (`scripts/prove-base-swap.mjs`) | the built plugin bundle contains neither a static base import nor an inlined kit declaration, and the plugin's BUILT bootstrap loads a SWAPPED base and takes prompt read/write + root resolution from it, with the artifact byte-identical |
| `pnpm proof:base-swap:mount` | the same, plus both plugins' full Cordis mount smokes against the built plugin + workspace base |
| `pnpm release:check:base` / `:mem` / `:work` | each package's own typecheck → build → test → pack gate |

### After changing ANY shared code under `base/**`

Regress **both** plugins, because a base change can break either one and nothing in the base's own
tests exercises a plugin's mount:

```
# mem (inside mem/)
pnpm build:dsh && node scripts/mount-smoke.mjs
# work (inside work/)
pnpm release:check && node scripts/mount-smoke.mjs
```

From the repository root the same two lines are
`pnpm build:dsh:mem && node mem/scripts/mount-smoke.mjs` and
`pnpm release:check:work && node work/scripts/mount-smoke.mjs`.
`pnpm proof:base-swap:mount` runs both mount smokes as one gate; the commands above are what to run
when iterating on a single plugin.

### Where the scripts live, and why some were NOT merged

- `scripts/` (repo root) owns everything that is about the WORKSPACE: `release-check.mjs` (the
  publishable set, the base-before-plugins order, one `zod`), `boundary-guard.mjs`, `prove-base-swap.mjs`,
  `clean.mjs`, and `scripts/lib/{harness-path,bootstrap-version}.mjs`.
- The two genuinely identical helpers were hoisted to `scripts/lib/` and the per-plugin copies were
  DELETED; `mem/scripts/*` and `work/scripts/*` import the root copies (no duplicate file remains).
- The plugin pipelines stay per plugin **on purpose** — `link-dsh` / `link-envinit` / `mount-smoke` /
  `pack-plugin` / `release-check` / `make-release-tree` are 80 %+ different implementations
  parameterised by each plugin's own package set, its own bundle pipeline (mem: `tsc` + the pinned
  tsdown client preset; work: `tsc` + esbuild + core-type relocation) and its own item list. A single
  parameterised script would need a switch per difference, which is exactly the "fake abstraction"
  this repository refuses. The shared SKELETON lives in `scripts/lib/` and in `base/`; a script that is
  truly identical gets hoisted, like the two above.
- `mem/scripts/release-check.mjs` remains the mem-scoped gate (it asserts only `mem/packages/plugin`
  is publishable there); the REPO-WIDE assertion — exactly `@avantf/dsh-plugin-base`, `@avantf/dsh-mem`
  and `@avantf/dsh-work`, everything else private — is `scripts/release-check.mjs`.
- There is exactly ONE `pnpm-workspace.yaml` and ONE catalog: the root one. The per-subtree workspace
  files (`mem/pnpm-workspace.yaml`, `work/pnpm-workspace.yaml`, `base/*/pnpm-workspace.yaml`) were
  deleted, so `pnpm -C work …` resolves through the merged workspace (verify with
  `pnpm -C work list`).
- **Known leftover (needs work before the RC tree flow is used again).** The per-subtree release-tree
  scripts (`mem/scripts/make-release-tree.mjs`, `work/scripts/make-release-tree.mjs`) and
  `*/scripts/sync-release-repo.sh` still expect their OLD per-subtree `pnpm-workspace.yaml`, which no
  longer exists. They are not part of the acceptance gates and were left per-subtree on purpose (their
  projections are 80 % different), but `pnpm release:tree` / `pnpm sync:rc` must be re-parameterised
  onto the merged root workspace before the next RC. The tarball `link:`/`file:` rule they enforce is
  already covered by `scripts/release-check.mjs` and both `pack-plugin.mjs` gates.

## The four working principles

1. **Reuse code and business logic.** If two plugins need the same behaviour, it belongs in `base/` (or
   in a shared private engine package, inlined) — not copied. The kit and the compat gate exist
   because these were copied once and drifted.
2. **Do not reuse for reuse's sake.** Sharing is not a goal by itself; a wrong abstraction is worse
   than a duplicate. Deliberate non-reuse, and why:
   - **two cores**: `@avantf/mem` (retrieval/knowledge engine) and `@avantf/work-core` (work-tree state
     machine) share no domain model. Merging them would couple two unrelated lifecycles.
   - **two client halves**: the browser bundles are different UIs driven by different remotes; only
     their build ABI (the pinned harness preset) is shared.
   - **each plugin's envinit item list and compat SPEC**: only a plugin knows what it registers.
3. **After changing shared code, regress every plugin.** See the commands above. A base change is not
   done when the base's own tests pass.
4. **Plugins are independent products.** Own package name, version, bundling and release; never import
   each other (not even relatively); either can be installed, upgraded or removed without the other.

## Boundaries and paths

- Keep `mem/` ↔ `work/` at zero imports (guarded). Shared code goes through `base/`.
- `AVANTF_HOME` sets the **family/managed root** (`$AVANTF_HOME`, else `~/.avantf/env`; resources under
  `<root>/tools`, `<root>/models`). The **data root** is an explicit `common.dataHome` → `$AVANTF_HOME`
  → config → `~/.avantf`; user data and editable text live there (`memory/`, `knowledge/`,
  `configs/*.yaml`, `prompts/*.md`). The two roots are deliberately different — do not conflate them.
- The compatibility gate is part of the base now: there is **no** `mem:compat`/`work:compat` item and
  no managed `~/.avantf/env/compat/**` download any more. A machine that still has `~/.avantf/env/compat/`
  (or an old `<dataHome>/dsh-compat/`) can delete it by hand — nothing reads it.
- Data files never move outside `~/.avantf/{memory,knowledge}`; everything a user EDITS lives in
  `~/.avantf/configs/*.yaml` and `~/.avantf/prompts/*.md`, never next to the databases.
