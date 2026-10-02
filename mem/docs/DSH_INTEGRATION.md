# DSH integration

> **Installing on another machine?** Follow [INSTALL.md](INSTALL.md) — the copy-paste
> runbook (build → link → mount → configure models → verify → troubleshooting).
> This page keeps the wiring details and the reasons behind them.

`@avantf/dsh-mem` is a native Cordis plugin (host service + tools + RPC + two
`conversation.view` client tabs). The host side has been verified to mount in a
real `@deepseek-ai/cordis` context (see `scripts/mount-smoke.mjs`). The tabs
render in the session view strip of the DSH web UI once the plugin is part of the web bundle.

## 1. Build the packages

```bash
cd <AVANTF>
pnpm install && pnpm build
pnpm build:dsh   # links harness packages + publishes the manifest stub, then tsc + tsdown (node half + client bundle)
```

> The startup compatibility gate, the environment-initialisation framework and the shared kit all live
> in ONE package: the family base **`@avantf/dsh-plugin-base`** (the formerly standalone
> `@avantf/dsh-envinit` and `@avantf/dsh-compat` packages were merged into it and are dead — no new
> versions, nothing depends on them). There is **no `mem:compat` npm-package item**: the gate is the
> base itself, and there is no download, no integrity verification and no managed `compat` root. Base
> is a **`peerDependency`** of the plugin (peer range `>=0.3.0 <1.0.0`) and is also declared in
> `devDependencies` (`>=0.3.0 <1.0.0`) so `pnpm install` puts it in the tree; the model-cache `flat` layout
> this plugin relies on landed in the framework's `0.1.2` (base is a NEW package, so it restarts its
> own version line at `0.1.0` — the old framework's numbers do not carry over). It is **never bundled** and
> **never imported by specifier**: a static import would break the whole plugin module when base is absent.
>
> The plugin's only static reference is a zero-dependency bootstrap inlined into the bundle
> (`packages/plugin/src/envinit-bootstrap.js`, vendored from the installed base's build output;
> `scripts/link-envinit.mjs` vendors it and `scripts/copy-envinit-bootstrap.mjs` places it in
> `lib/types/` between `tsc` and `tsdown`, so tsdown inlines it into `lib/index.js`). At startup it
> resolves base with `createRequire(...).resolve('@avantf/dsh-plugin-base/package.json')` — from the
> plugin's own dependency tree, normally `node_modules/@avantf/dsh-plugin-base` — dynamically
> `import()`s it, and validates the version against the inlined `supportedRange`. If base is absent or
> the version is not accepted: one `envinit: WARNING`, and the plugin **mounts anyway, degraded**
> (never refuses to mount, never throws). Degradation is per capability: no prompt-file layer → the
> plugin's OWN built-in default prompt bodies (those defaults live in the plugin, which is not
> duplication); no gate → the existing `compat:` WARNING path and the gate is skipped (its judgement
> semantics are unchanged: only a PROVEN incompatibility refuses the mount, "cannot tell" is a note, a
> version difference is only a warning, and it never throws); no resource provisioning (pandoc binary
> item, embedding model item) → the legacy `@avantf/mem-provision` / legacy-tools-dir path; tools /
> service / Remote / UI faces are unaffected and still mount.
>
> The interface generation is its own axis, judged at runtime by the base: the build bakes
> `{ baseVersion, interfaceVersion }` into `lib/interface-version.json`, and at startup the plugin
> reads it back through the base's `readInterfaceRequirement` and asks the base's `checkInterface`.
> `incompatible` (a base inside the peer range that reports another generation — either direction)
> is one `WARNING` plus the SAME degradation as "base absent": the base's shared capabilities are not
> used (own prompt defaults, gate skipped, legacy provisioning) and the plugin still mounts;
> `cannot-tell` (a base without the gate, a missing/malformed bake) is only a `WARNING` and the base
> is used normally. An interface change therefore no longer requires the plugins to move their peer
> range in lockstep.
>
> Shared business logic is consumed at RUNTIME from base (taken off the dynamically imported module),
> never inlined at build time into the plugin — so a fix there ships with ONE base release and no
> plugin rebuild. The one exception is the `typert` `strict` wire codec and the small literal
> descriptor conventions, which stay in the plugin (they mirror a host convention in a couple of
> lines): changing those needs a plugin release. Local development needs no checkout:
> `scripts/link-envinit.mjs` (run by `pnpm build:dsh`) reads the install, and
> `DSH_ENVINIT=<checkout>` is the explicit opt-in for co-developing the base.
> `scripts/assert-envinit-artifacts.mjs` (also run by `pnpm build:dsh`) asserts the bootstrap is
> really inlined, base is never imported by specifier, and `lib/client.js` is clean; the tarball must
> carry no `link:`/`file:` specifier (`pack-plugin` / `make-release-tree` both refuse one).
> **Publish the base BEFORE the plugin** (see `docs/RELEASING.md`).

> **What the gate's version line compares.** `declared` is **the dsh this artifact was compiled
> against**: `scripts/link-dsh.mjs` links the peers from the installed dsh and then
> `../scripts/lib/build-versions.mjs` bakes their exact versions into `lib/dsh-build.json`, which
> `provision.ts` reads back with the base's `readBuildVersions()`; a missing file falls back PER
> PACKAGE to the `package.json` peer range's floor. `runtime` is **the dsh this artifact's own
> links resolve now**. It never observes the HOST's identity — a plugin cannot. So a checkout host
> loading this plugin linked to the installed dsh prints the INSTALLED version in its
> `compat: ok` line as `dsh links: …` (deliberately **not** `running …`, which would read as a
> claim about the host); that is a documented boundary, not a bug. A `declared ≠ runtime`
> difference only WARNs and the plugin still loads.

> The harness checkout is discovered automatically (`scripts/harness-path.mjs`) with the
> same repo-relative convention `tsdown.config.ts` uses — `<repo>/../harness/deepseek-harness`
> and a few siblings; set `DSHHARNESS` to override.

> The DSH plugin (`@avantf/dsh-mem`) imports `@deepseek-ai/dsh-tools` /
> `dsh-typert-protocol` (and type-only `dsh-system-prompt`, for the prompt registry's
> `Context` augmentation) whose transitive deps aren't all npm-published. `pnpm build:dsh`
> runs `scripts/link-dsh.mjs` (symlinks those packages from the harness checkout and
> publishes the `<harness>/packages/client/avantf-dsh-mem` manifest
> stub the client-bundle preset needs) and then `tsc && tsdown`. Verify the mount with
> `node scripts/mount-smoke.mjs` (a real Cordis mount: `avantfMemory` service +
> `avantfMem` remote + 8 tools via `ctx.tools.register` + 3 prompt sections (`avantf:memory-usage` / `knowledge-usage` / `kb-edit`) + 2 conditional contexts
> system-prompt section, **no `harness` global**).
>
> `tsdown.config.ts` calls the harness `clientBundle` preset, so the build emits both
> faces: `lib/index.js` (Node half) and `lib/client.js` (browser half — a
> `window.__ModuleLoader__.load({id, factory})` CJS factory with `react` resolved from
> the platform module table).
>
> The plugin is a **standard Cordis plugin** now — it does NOT use the dynamic-package
> `harness` API, so a normal DSH profile plugin can run it.

## 2. Make the packages resolvable to DSH

DSH plugins are loaded from a profile's `node_modules`. With released packages, install the plugin AND
its base peer — pnpm has `autoInstallPeers: false`, so the peer is not pulled in automatically
(npm-style installers do pull it in). From the DSH profile workspace:

```bash
cd ~/.dsh/profiles/web
pnpm add @avantf/dsh-plugin-base @avantf/dsh-mem
```

During development, linking the source checkout is enough: the linked plugin resolves base from its own
dependency tree (`pnpm install` put it there through the plugin's `devDependencies`).

```bash
cd ~/.dsh/profiles/web
pnpm add <AVANTF>/packages/plugin
```

(Storage is the runtime's own `node:sqlite` — no native database module to build or match an ABI
against. The optional `nodejieba`, `hnswlib-node` and `@huggingface/transformers` accelerators
degrade gracefully when absent. The engine packages
`@avantf/mem*` are inlined into `lib/index.js` and are NOT separate runtime installs.)

## 3. Mount it

Add a row to `~/.dsh/profiles/web/cordis.patch.yml`:

```yaml
- insert:
    - id: avantf-mem
      name: '@avantf/dsh-mem'
      config:
        mode: cordis
        dataHome: '~/.avantf'
```

(or use `dsh web --patch <overlay.yml>` with the same row to try it without editing the profile.)

## 4. Client tabs

The two `conversation.view` tabs (`记忆` id=`memory` order=20, `知识` id=`knowledge` order=30)
are emitted by `@avantf/dsh-mem/client` as a DSH client bundle (`lib/client.js`).

The client module table is composed **at runtime**: the host scans the Loader's
entries for packages declaring `dsh.client` (`@deepseek-ai/dsh-client-modules`),
reads each `exports["./client"]` file, and serves its bytes in a browser combo
script — so no harness rebuild is needed, but the file must be the
`__ModuleLoader__.load` factory that `tsdown`/`clientBundle` produces.

`package.json` therefore declares:

```jsonc
"dsh": { "client": { "inject": ["@deepseek-ai/dsh-client-ui-conversation", "@deepseek-ai/dsh-api-remotes"], "platform": "web" } },
"exports": { "./client": { "types": "./lib/types/client/index.d.ts", "default": "./lib/client.js" } }
```

`dsh.client.inject` lists the client **package rows** that must arrive first:
`ui-conversation` owns the `conversation.view` slot the two tabs register into, and `api-remotes`
provides the `remote` bridge. The panels live **only** in the main window's view strip — the
settings page carries no 记忆/知识 entries. (`settings.section` used to hold a duplicate pair as the
route reachable while a blank session hides the strip; that duplication was removed on request, so
`ui-settings` is no longer a client dependency.)

The client half is **one fiber** — `inject = ['slots', 'remote']`, a single `apply` — and it mounts
the `avantfMem` namespace through `ctx.remote.$mount()`, then reads it back with
`ctx.get('remote.avantfMem')` rather than through a dotted `inject` key. That is deliberate: the boot
audit THROWS when any client entry is still pending, and an out-of-tree package's own namespace only
exists after its own contribution mounts, so listing `remote.avantfMem` would park this entry and take
the whole web tree down (INSTALL.md's troubleshooting table names that failure mode).

### Wire faces (`src/remote.ts`, hand-written)

DSH packages normally ship Typert-generated faces (`typert.host.js` /
`typert.remote-client.js`), but the generator only runs inside the harness
workspace. Both faces are therefore hand-written in `src/remote.ts` following
the generator's conventions (zod v4 strict codecs, one `args` object parameter
per method, `@avantf/dsh-mem#avantfMem/<method>` ids):

> **Every codec and every schema entry carries BOTH `schema` and `create()`.** The host's validator
> moved from `codec.schema.parse` (0.1.5) to `codec.create()` (0.1.6), and the registry's schema entry
> moved from `{name, schema}` to a `create()` factory — each generation checks only its own member, so
> one build carrying both serves either host. A build with only `schema` is refused at registration
> (0.1.6: *"has no create() factory"*), which the startup gate would turn into a clean refusal —
> correct, but the plugin would simply not load. The compatibility gate's wire probe IS this
> contribution (`probeTypert: () => hostContribution` in `src/provision.ts`), so "the probe passed"
> means "the real face will register".
>
> **Why this stays in the plugin.** The `typert` `strict` wire codec and the small literal descriptor
> conventions are one documented exception to "shared logic is consumed from base at runtime":
> they mirror a host convention in a couple of lines rather than being shared business logic, so they
> live in each plugin — and **changing them needs a plugin release**. The other plugin-local pieces are
> the plugin's own logger and its base-less fallbacks. What IS taken off the dynamically imported base
> module: the compatibility gate's rules/probes/verification, the envinit provisioner, the prompt-file
> layer, and (in the mission plugin) `resolveDataHome`, so a fix there ships with ONE base release and no
> plugin rebuild.
>
> Optional fields are written `X.optional()`, never `z.union([z.undefined(), X])`: the two accept the
> same payloads, but the union is invisible to the host's `z.toJSONSchema()` projector (it throws
> *"Undefined cannot be represented in JSON Schema"*), which the real-face probe runs — so the union
> form made a healthy host read as incompatible.

- **Host face** — registered via `ctx.typert.register(hostContribution)` (the
  documented manual path for hand-written wire schemas; the plugin now injects
  `typert`). Without it the gateway would fall back to SRC discovery.
- **Client face** — mounted via `ctx.remote.$mount(clientContribution)` in the
  client `apply`; the mount installs the `remote.avantfMem` service the pages
  depend on.

`scripts/link-dsh.mjs` also links `dsh-typert-registry` (type-only), and `zod` is resolved ONCE for the
whole merged workspace from the ROOT `pnpm-workspace.yaml` `catalog:` (`zod: 4.6.5`, tracking the version
the installed dsh ships) to match the harness's registry types; the base's own `peerDependencies.zod`
stays the wide `>=4.4.3 <5`, so the same base serves both the workspace and the installed dsh.

## 5. Verify (three-step)

1. In a DSH session, ask the agent to remember a fact and confirm it calls `mem_remember`.
2. In a new session, ask to recall it and confirm `mem_recall` / `kb_query` return it.
3. Open a session and switch to the 记忆 / 知识 tab (after 对话 / 轨迹) and confirm they render + can search.
