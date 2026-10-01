#!/usr/bin/env node
/**
 * Pack the plugin into ./release (`pnpm pack:plugin`) and assert the tarball is self-contained:
 * no bundled `@deepseek-ai/*` (all peers, keeping host identities single) and no reference to the
 * unpublished `@avantf/mission-core`, whose runtime and declarations are inlined instead.
 *
 * Usage:
 *   pnpm pack:plugin               # pack into release/ + the static tarball assertions
 *   pnpm pack:plugin --mount       # + extract the tarball into a scratch profile and mount it
 *   pnpm pack:plugin --out <dir>   # pack destination (default: <repo>/release)
 *   pnpm pack:plugin --keep        # keep the scratch profile when --mount fails
 *
 * Every flag that is understood is listed above, and an UNKNOWN one exits non-zero: `--mount` used
 * to be accepted and silently ignored, so a release run looked like the packed tarball had been
 * extracted and mounted when nothing of the sort had happened. A flag this script cannot honour
 * must fail loudly — never be a no-op.
 *
 * Run `pnpm build:dsh` first (this script never builds): `lib/index.js` must be the artifact the
 * assertions describe. `--mount` needs the installed dsh (`npm i -g @deepseek-ai/dsh`), the peers a
 * real profile resolves.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, statSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { withWorkspaceVersions } from '../../scripts/lib/versions.mjs'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * Parse the flags FIRST, so an unsupported option fails before anything is packed.
 *
 * `--out` takes a value; a missing one is an error, not a silent default. `--keep` is only
 * meaningful together with `--mount` (there is no scratch profile otherwise), so it is rejected
 * alone rather than accepted as a no-op.
 */
const args = process.argv.slice(2)
let mount = false
let keep = false
let outArg
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index]
  if (arg === '--mount') { mount = true; continue }
  if (arg === '--keep') { keep = true; continue }
  if (arg === '--out') {
    outArg = args[index + 1]
    if (outArg === undefined || outArg.startsWith('--')) {
      console.error('pack-plugin: --out needs a directory')
      process.exit(2)
    }
    index += 1
    continue
  }
  console.error(`pack-plugin: unknown option ${arg}`)
  console.error('  usage: node scripts/pack-plugin.mjs [--mount] [--keep] [--out <dir>]')
  console.error('  an unsupported option is NOT ignored — that is how `--mount` looked verified without mounting anything')
  process.exit(2)
}
if (keep && !mount) {
  console.error('pack-plugin: --keep only applies to --mount (without it there is no scratch profile to keep)')
  process.exit(2)
}
const outDir = outArg === undefined ? join(repo, 'release') : resolve(outArg)
if (outDir === resolve('/')) {
  console.error('pack-plugin: refusing to pack into /')
  process.exit(2)
}
mkdirSync(outDir, { recursive: true })
// Remove only tarballs: `release/` also holds a tracked source file the development tree needs.
for (const entry of readdirSync(outDir)) {
  if (entry.endsWith('.tgz')) rmSync(join(outDir, entry))
}

const packages = ['plugin']
const failures = []

/**
 * Resolve `name` upward to the nearest `package.json`: several DSH packages do not export
 * `./package.json`, so resolving it directly throws. A marker (not `undefined`) tells "missing"
 * apart from "resolved, wrong version".
 */
function linkedVersion(require, name) {
  try {
    let dir = dirname(require.resolve(name))
    for (;;) {
      const manifest = join(dir, 'package.json')
      if (existsSync(manifest)) {
        const version = JSON.parse(readFileSync(manifest, 'utf8')).version
        return typeof version === 'string' && version !== '' ? version : 'NO-VERSION'
      }
      const up = dirname(dir)
      if (up === dir) return 'NO-PACKAGE-JSON'
      dir = up
    }
  } catch (error) {
    return `UNRESOLVED(${String(error?.code ?? error?.name ?? error)})`
  }
}

/**
 * Every module specifier the source imports or requires, in all forms; comments are stripped
 * first so documentation examples cannot trip a `from`-only pattern.
 */
function importSpecifiers(source) {
  const code = stripComments(source)
  const patterns = [
    /\bfrom\s+['"]([^'"]+)['"]/gu,          // import x from '…' / export … from '…'
    /\bimport\s+['"]([^'"]+)['"]/gu,        // side-effect import '…'
    /\bimport\s*\(\s*['"]([^'"]+)['"]/gu,   // dynamic import('…')
    /\brequire\s*\(\s*['"]([^'"]+)['"]/gu,  // require('…')
  ]
  const found = new Set()
  for (const pattern of patterns) for (const match of code.matchAll(pattern)) found.add(match[1])
  return [...found]
}

/**
 * The bare specifiers `source` reaches through a STATIC value import only.
 *
 * Dynamic `import('…')` is deliberately excluded: it is exactly how the base
 * (`@avantf/dsh-plugin-base`) is meant to be reached — through the inlined bootstrap — and it is the
 * only form that still works when the peer is missing, so the plugin can warn and mount degraded. A
 * STATIC value import would throw while this module is being evaluated, before the bootstrap could
 * run, which is the one shape the family forbids. `tsc` erases `import type`, so anything left in an
 * emitted artifact that matches here is a value import.
 */
function staticImportSpecifiers(source) {
  const found = new Set()
  for (const line of stripComments(source).split('\n')) {
    const statement = /^\s*import\s+(?!\()(.+)$/u.exec(line)
    if (statement === null) continue
    const rest = statement[1].trim()
    const from = /\bfrom\s*['"]([^'"]+)['"]/u.exec(rest)
    if (from !== null) {
      found.add(from[1])
      continue
    }
    const bare = /^['"]([^'"]+)['"]/u.exec(rest)
    if (bare !== null) found.add(bare[1])
  }
  return [...found]
}

/**
 * The base's KIT implementation, recognized by a string only it carries.
 *
 * Shared helpers (prompt files, logger, family paths, Typert conventions) must be taken OFF the
 * dynamically loaded base at runtime, never inlined: `prompt file was blank and has been filled` is
 * a line from `PromptFiles.load()` (`base/plugin-base/src/kit/prompt_files.ts`), and it surviving in
 * a plugin bundle means someone imported the kit as a value and the bundler carried it in — which
 * would make a shared-helper fix require republishing every plugin.
 */
const KIT_IMPLEMENTATION_MARKER = 'prompt file was blank and has been filled'

/** Remove line and block comments while leaving string literals alone. */
function stripComments(source) {
  let out = ''
  let quote = null
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i]
    const next = source[i + 1]
    if (quote !== null) {
      out += ch
      if (ch === '\\') { out += next ?? ''; i += 1; continue }
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; out += ch; continue }
    if (ch === '/' && next === '/') { while (i < source.length && source[i] !== '\n') i += 1; out += '\n'; continue }
    if (ch === '/' && next === '*') {
      i += 2
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i += 1
      i += 1
      continue
    }
    out += ch
  }
  return out
}

/**
 * Every file the tarball will carry, per the manifest's `files` whitelist — `lib/` also holds
 * `tsc` intermediates importing the core, so a directory scan would fail for the wrong reason.
 */
function shippedFiles(dir, manifest) {
  const out = []
  const walk = (path) => {
    const stat = statSync(path, { throwIfNoEntry: false })
    if (stat === undefined) return
    if (stat.isDirectory()) {
      for (const child of readdirSync(path)) walk(join(path, child))
      return
    }
    out.push(path)
  }
  for (const listed of manifest.files ?? []) walk(join(dir, listed))
  return out
}

/**
 * Whether a shipped file is the BROWSER half — excluded from the peer scan because `react`,
 * `react-dom` and `dsh-client-*` resolve from the web shell's platform module table, not npm;
 * `client-smoke.mjs` checks that contract against the built bundle.
 */
function isBrowserHalf(dir, file) {
  const rel = relative(dir, file).split(sep).join('/')
  return rel === 'lib/client.js' || rel.startsWith('lib/types/client/')
}

for (const name of packages) {
  const dir = join(repo, 'packages', name)
  const manifest = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))

  // ── 1. no DSH package may be a runtime dependency of this package ─────────
  // All are peers by design: a bundled copy would mean two registries and two schema identities.
  for (const [dependency, range] of Object.entries(manifest.dependencies ?? {})) {
    if (dependency.startsWith('@deepseek-ai/')) {
      failures.push(`${manifest.name}: ${dependency}@${range} is a runtime dependency; it must be a peer`)
    }
  }

  // ── 2. every imported peer must be declared, in EVERY shipped file ─────────
  const entry = join(dir, 'lib', 'index.js')
  const source = readFileSync(entry, 'utf8')
  const peers = new Set(Object.keys(manifest.peerDependencies ?? {}))
  // Scan what the TARBALL carries, not just the bundled entry: dead `lib/*.js` and `.d.ts` are
  // how an undeclared import slips past a green run; relative specifiers are skipped.
  const found = shippedFiles(dir, manifest)
    .filter((file) => /\.(?:js|d\.ts)$/u.test(file) && !isBrowserHalf(dir, file))
    .flatMap((file) =>
      importSpecifiers(readFileSync(file, 'utf8'))
        .filter((specifier) => !specifier.startsWith('.') && !specifier.startsWith('node:'))
        .map((specifier) => ({ file, specifier })),
    )
  // Non-vacuity, tied to the declaration: a package that DECLARES deepseek peers must import
  // some, so a scan that finds none is broken.
  const declaredDeepseek = [...peers].filter((name) => name.startsWith('@deepseek-ai/'))
  if (declaredDeepseek.length > 0 && found.length === 0) {
    failures.push(
      `${manifest.name}: declares ${String(declaredDeepseek.length)} @deepseek-ai peer(s) but no shipped file imports any`
      + ' — the scan is broken, not the package',
    )
  }

  for (const { file, specifier } of found) {
    const pkg = specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier
    const types = file.endsWith('.d.ts')
    // `@avantf/mission-core` is INTERNAL: nothing outside this workspace resolves the name, the
    // runtime is inlined into the entry, and the declarations are carried into `lib/mission-core/`.
    if (pkg === '@avantf/mission-core') {
      failures.push(types
        ? `${manifest.name}: ${relative(dir, file)} names @avantf/mission-core — the core is not published, so its types must be carried into lib/mission-core and repointed (see scripts/build.mjs inlineCoreTypes)`
        : `${manifest.name}: ${relative(dir, file)} imports @avantf/mission-core at runtime — the host entry was not bundled (see scripts/build.mjs bundleHost)`)
      continue
    }
    if (!peers.has(pkg)) {
      failures.push(`${manifest.name}: ${relative(dir, file)} imports ${pkg} but it is not a declared peer`)
    }
  }

  // ── 2b. the relative-import closure of the shipped tree is complete ────────
  // `build.mjs` carries `@avantf/mission-core`'s declarations into `lib/mission-core/` and repoints every
  // `from '@avantf/mission-core'` to a relative specifier. Nothing checked the other end: a partial copy
  // (the copy step was NOT recursive while the repointing was) ships a specifier that resolves to
  // nothing, and the peer scan above skips relative specifiers on purpose. So: every relative
  // specifier in the shipped tree must land on a file the tarball also carries.
  const shipped = new Set(shippedFiles(dir, manifest))
  const dangling = []
  let relativeSpecifiers = 0
  for (const file of shipped) {
    if (!/\.(?:js|d\.ts)$/u.test(file) || isBrowserHalf(dir, file)) continue
    for (const specifier of importSpecifiers(readFileSync(file, 'utf8'))) {
      if (!specifier.startsWith('.')) continue
      relativeSpecifiers += 1
      const base = resolve(dirname(file), specifier)
      // `tsc` emits NodeNext specifiers: `./x.js` from a declaration file means `x.d.ts` on disk.
      const candidates = specifier.endsWith('.js')
        ? [base, base.replace(/\.js$/u, '.d.ts'), `${base}.d.ts`]
        : [base, `${base}.d.ts`, join(base, 'index.js'), join(base, 'index.d.ts')]
      if (!candidates.some((candidate) => shipped.has(candidate))) {
        dangling.push(`${relative(dir, file)} → ${specifier}`)
      }
    }
  }
  // Non-vacuity: this tree carries the core's declarations, which reference each other by path, so a
  // scan that finds no relative specifier at all is broken.
  if (relativeSpecifiers === 0 && shipped.some((file) => relative(dir, file).startsWith('lib/mission-core/'))) {
    failures.push(`${manifest.name}: the shipped tree carries lib/mission-core/ but no relative specifier was found — the closure scan is broken`)
  }
  if (dangling.length > 0) {
    failures.push(
      `${manifest.name}: ${String(dangling.length)} dangling relative import(s) in the shipped tree — `
      + `a partial copy would ship a specifier that resolves to nothing: ${dangling.slice(0, 5).join(', ')}`,
    )
  } else if (relativeSpecifiers > 0) {
    console.log(`  ok   ${manifest.name}: relative-import closure complete (${String(relativeSpecifiers)} specifier(s) checked)`)
  }

  // ── 3. the framework: a peer, never bundled, with the bootstrap inlined ─────
  // The FRAMEWORK must be a peer: a bundled copy is a second orchestrator, and a static value
  // import would throw before the inlined bootstrap could run. The zero-dependency BOOTSTRAP is
  // a copied file imported by relative path, since this `tsc`-only plugin has no bundler.
  if (name === 'plugin') {
    if (manifest.dependencies?.['@avantf/dsh-plugin-base'] !== undefined) {
      failures.push(`${manifest.name}: @avantf/dsh-plugin-base is a runtime dependency; it must be a peer`)
    }
    // And a REQUIRED peer: that is the only declaration a consumer's package manager installs on
    // its own (npm 7+ always; pnpm with its default `autoInstallPeers`). Optional would drop the
    // framework from every fresh install; the other peers stay optional to keep identity single.
    if (manifest.peerDependenciesMeta?.['@avantf/dsh-plugin-base']?.optional === true) {
      failures.push(`${manifest.name}: @avantf/dsh-plugin-base is marked an optional peer — it must be required, or installing this package does not install the framework`)
    }
    // Asserted against the ENTRY, which is what the host loads: after `bundleHost` it carries the
    // initialiser's code and the bootstrap reference, while `lib/envinit.js` is not shipped. The
    // check is for STATIC imports only — the base is reached through the inlined bootstrap's dynamic
    // `import()`, which is what keeps a missing peer a WARNING instead of a module-evaluation throw.
    if (staticImportSpecifiers(source).includes('@avantf/dsh-plugin-base')) {
      failures.push(`${manifest.name}: lib/index.js has a STATIC value import of @avantf/dsh-plugin-base — it must be type-only or dynamic, or a missing peer makes the whole module unloadable`)
    }
    if (!importSpecifiers(source).includes('./envinit-bootstrap.js')) {
      failures.push(`${manifest.name}: lib/index.js does not import the inlined bootstrap by relative path`)
    }

    // The bootstrap must stay self-contained, or the inlined loader is broken.
    const bootstrapPath = join(dir, 'lib', 'envinit-bootstrap.js')
    if (!existsSync(bootstrapPath)) {
      failures.push(`${manifest.name}: lib/envinit-bootstrap.js is missing — the bootstrap is not inlined`)
    } else {
      const foreign = importSpecifiers(readFileSync(bootstrapPath, 'utf8')).filter((s) => !s.startsWith('node:'))
      if (foreign.length > 0) {
        failures.push(`${manifest.name}: the inlined bootstrap imports non-node modules: ${foreign.join(', ')}`)
      }
    }

    // The shared KIT must be CONSUMED at runtime from the base, never inlined: the base is a peer
    // loaded by the bootstrap, and inlining its helpers would make a shared-helper fix need a plugin
    // release. The browser half must not reach it at all.
    for (const shipped of shippedFiles(dir, manifest).filter((file) => file.endsWith('.js') && !isBrowserHalf(dir, file))) {
      if (readFileSync(shipped, 'utf8').includes(KIT_IMPLEMENTATION_MARKER)) {
        failures.push(`${manifest.name}: ${relative(dir, shipped)} contains the base kit's PromptFiles implementation — share it by dynamic import from the base, never by inlining`)
      }
    }
    const clientPath = join(dir, 'lib', 'client.js')
    if (!existsSync(clientPath)) {
      failures.push(`${manifest.name}: lib/client.js is missing — the browser half was not built`)
    } else {
      const client = readFileSync(clientPath, 'utf8')
      const reached = importSpecifiers(client).filter((s) => s.startsWith('@avantf/'))
      if (reached.length > 0) {
        failures.push(`${manifest.name}: lib/client.js reaches ${reached.join(', ')} — the browser half must not import any @avantf/* package`)
      }
      if (client.includes(KIT_IMPLEMENTATION_MARKER)) {
        failures.push(`${manifest.name}: lib/client.js contains the base kit's PromptFiles implementation — it must not carry shared host-side helpers`)
      }
    }

    // The base is a peer + a devDependency. The devDependency is what makes `pnpm install` fetch the
    // copy the plugin is type-checked and vendored against (`autoInstallPeers: false` means the peer
    // alone installs nothing); the peer is what a consumer's package manager installs. There used to
    // be a second, pinned `COMPAT_RANGE` fallback in `envinit.ts`; that item is gone, so the manifest
    // is the ONE place the range is written.
    const envinitSource = readFileSync(join(dir, 'src', 'envinit.ts'), 'utf8')
    if (typeof manifest.dependencies?.['@avantf/dsh-plugin-base'] === 'string') {
      failures.push(`${manifest.name}: @avantf/dsh-plugin-base is a runtime dependency; declare it as a peer + devDependency`)
    }
    if (typeof manifest.peerDependencies?.['@avantf/dsh-plugin-base'] !== 'string') {
      failures.push(`${manifest.name}: @avantf/dsh-plugin-base is not declared in peerDependencies — a consumer's install would not provide the base`)
    }
    const declaredBase = manifest.devDependencies?.['@avantf/dsh-plugin-base']
    if (typeof declaredBase !== 'string' || declaredBase === '') {
      failures.push(`${manifest.name}: @avantf/dsh-plugin-base is not declared in devDependencies — pnpm install would have no copy to build and vendor the bootstrap from`)
    }

    // The declared side of the gate must be the baked build versions (`link-dsh.mjs` writes them),
    // not a peer range's floor.
    const bakedPath = join(dir, 'lib', 'dsh-build.json')
    if (!existsSync(bakedPath)) {
      failures.push(`${manifest.name}: lib/dsh-build.json is missing — run scripts/link-dsh.mjs so the gate knows what this build compiled against`)
    } else {
      const baked = JSON.parse(readFileSync(bakedPath, 'utf8'))
      for (const pkg of ['@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-typert-protocol']) {
        if (typeof baked[pkg] !== 'string' || baked[pkg] === '') {
          failures.push(`${manifest.name}: dsh-build.json has no version for ${pkg}`)
        }
      }

      // ── bake ↔ link ──────────────────────────────────────────────────────────
      // `dsh-build.json` is what the plugin tells the gate it compiled against, but `link-dsh`
      // writes it beside a `lib/` that `tsc` never cleans: an unrelinked build keeps a bake line
      // for a dsh it no longer resolves, and the gate would report `ok` on exactly the drift it
      // exists to catch. Every baked entry is re-resolved here and must equal the JSON.
      const require = createRequire(entry)
      for (const [pkg, want] of Object.entries(baked)) {
        const got = linkedVersion(require, pkg)
        if (got === want) continue
        failures.push(
          `${manifest.name}: dsh-build.json is out of step with this build's links — ${pkg} baked=${String(want)} linked=${got}`
          + (got.startsWith('UNRESOLVED')
            ? ' (the package does not resolve from this artifact at all — failure class 4: dependency missing; run scripts/link-dsh.mjs --runtime)'
            : ' (the bake is stale or the links moved; run pnpm build:dsh, without --skip-link)'),
        )
      }

      // The gate's VERSION_PACKAGES list must cover every baked package, or a drift in it is silent.
      const declaredList = /const VERSION_PACKAGES: readonly string\[\] = \[([\s\S]*?)\]/u.exec(envinitSource)?.[1]
      if (declaredList === undefined) {
        failures.push(`${manifest.name}: src/envinit.ts no longer declares VERSION_PACKAGES — the gate's version list cannot be verified against the bake`)
      } else {
        const listed = new Set([...declaredList.matchAll(/'([^']+)'/gu)].map((match) => match[1]))
        for (const pkg of Object.keys(baked)) {
          if (!listed.has(pkg)) {
            failures.push(`${manifest.name}: dsh-build.json bakes ${pkg} but VERSION_PACKAGES does not name it — the compatibility gate would not notice it drifting`)
          }
        }
        // …and the REVERSE. One-way coverage let a package the gate names fall out of the bake: the
        // gate then read no baked version and silently fell back to the peer range's lower bound, i.e.
        // it vouched for a build whose "compiled against" side had quietly degraded. Two-way, or it is
        // not an assertion about agreement.
        for (const pkg of listed) {
          if (baked[pkg] === undefined) {
            failures.push(`${manifest.name}: VERSION_PACKAGES names ${pkg} but dsh-build.json does not bake it — the gate would fall back to the peer range's lower bound instead of this build's version`)
          }
        }
      }
    }

    // The RUNTIME interface gate reads the generation this build was written for from
    // `lib/interface-version.json` (`link-envinit.mjs` bakes it). Without the file the gate degrades to
    // "not baked" — a warning, which is by design at startup, but a published artifact that never had
    // the record cannot run the gate at all, so it is a pack failure here.
    const interfaceRecord = join(dir, 'lib', 'interface-version.json')
    if (!existsSync(interfaceRecord)) {
      failures.push(`${manifest.name}: lib/interface-version.json is missing — run scripts/link-envinit.mjs so the interface gate knows which base generation this build was written for`)
    } else {
      const record = JSON.parse(readFileSync(interfaceRecord, 'utf8'))
      if (!Number.isInteger(record.interfaceVersion) || record.interfaceVersion <= 0) {
        failures.push(`${manifest.name}: interface-version.json declares no positive integer interfaceVersion (found ${JSON.stringify(record.interfaceVersion)})`)
      }
      if (typeof record.baseVersion !== 'string' || record.baseVersion === '') {
        failures.push(`${manifest.name}: interface-version.json has no baseVersion — the record does not say which base it was taken from`)
      }
    }
  }

  // ── 4. pack ────────────────────────────────────────────────────────────────
  console.log(`\n▶ pack ${manifest.name}`)
  // `pnpm pack`, not `npm pack`: rewriting `catalog:` / `workspace:*` into registry ranges is
  // pnpm's mission, and npm would pack a tarball nobody can install.
  //
  // That rewrite is also why the private workspace-protocol targets get their version MATERIALIZED
  // around this call and lose it again right after: `pnpm pack` substitutes `workspace:*` with the
  // TARGET's version, and the engines deliberately carry none in the tree (the version is recorded once,
  // in this package's manifest). Nothing is committed — `version:check` fails on a leftover.
  // The workspace root, not this subtree: `workspaceTargets` scans every group's manifests.
  const result = withWorkspaceVersions(resolve(repo, '..'), manifest.version, () =>
    spawnSync('pnpm', ['pack', '--pack-destination', outDir], {
      cwd: dir,
      stdio: 'inherit',
      env: process.env,
    }))
  if (result.status !== 0) {
    failures.push(`${manifest.name}: npm pack failed`)
  }
}

const tarballs = readdirSync(outDir).filter((file) => file.endsWith('.tgz'))
if (tarballs.length !== packages.length) {
  failures.push(`expected ${String(packages.length)} tarballs, found ${String(tarballs.length)}`)
}
for (const tarball of tarballs) {
  const listing = spawnSync('tar', ['-tzf', join(outDir, tarball)], { encoding: 'utf8' })
  const files = listing.stdout ?? ''
  if (!files.includes('package/package.json')) failures.push(`${tarball}: missing package.json`)
  if (!files.includes('package/lib/index.js')) failures.push(`${tarball}: missing lib/index.js`)
  // The interface record must ship, and this is asserted on the TARBALL — section 3 checks the built
  // directory, which a `files` whitelist can still exclude. Without the record the runtime gate degrades
  // to "not baked" (`cannot-tell`): a warning by design at startup, but a published artifact that can
  // never run the gate at all. Same assertion the sibling tree's packer makes.
  if (!files.includes('package/lib/interface-version.json')) {
    failures.push(`${tarball}: missing lib/interface-version.json — the interface gate cannot run without the baked record (check the manifest's \`files\`)`)
  }
  // The npm page is the package's OWN README (npm shows `package/README.md`), so assert it ships and
  // that its title names the package the tarball declares. A copy/rename slip would otherwise publish
  // one plugin's page under another's name, and nothing else in this chain would notice.
  const fromTarball = (entry) => spawnSync('tar', ['-xzOf', join(outDir, tarball), entry], { encoding: 'utf8' }).stdout ?? ''
  const packed = JSON.parse(fromTarball('package/package.json'))
  const readme = fromTarball('package/README.md')
  if (!files.includes('package/LICENSE')) {
    failures.push(`${tarball}: missing LICENSE — npm ships the license file beside package.json, and its absence is a compliance gap, not a cosmetic one`)
  }
  if (readme.trim() === '') {
    failures.push(`${tarball}: missing README.md — the npm page has to be the package's own README`)
  } else if (readme.split('\n')[0]?.trim() !== `# ${String(packed.name)}`) {
    failures.push(`${tarball}: README.md starts with ${JSON.stringify(readme.split('\n')[0])}, expected "# ${String(packed.name)}"`)
  }
}

// ── 5. optional: mount the PACKED tarball in a scratch profile ─────────────────
// `--mount` proves the tarball itself — the bytes the registry would serve — can be loaded by a
// host. The build tree passing `pnpm build:dsh` says nothing about that: the tarball is assembled by
// `pnpm pack` from the manifest's `files` whitelist, so a missing file or a broken entry only shows
// up once it is extracted and imported. The extraction and the peer links live here; the mount is
// the SAME `scripts/mount-smoke.mjs` the release gate runs, pointed at the extracted package through
// the packed-artifact hooks (`AVANTF_PLUGIN_DIR` / `AVANTF_MOUNT_SCRATCH`) — nothing is copied.
if (mount && failures.length === 0) {
  const pluginDir = join(repo, 'packages', 'plugin')
  const packedTarball = join(outDir, tarballs[0])
  const linkedPeers = join(pluginDir, 'node_modules', '@deepseek-ai')

  if (!existsSync(linkedPeers)) {
    failures.push(`${packedTarball}: the @deepseek-ai peers are not linked — run \`pnpm build:dsh\` (or node scripts/link-dsh.mjs) before --mount`)
  } else {
    /**
     * Extract `packedTarball` into a scratch profile and mount it there.
     *
     * `linkBase` is the whole point of running twice: with the base linked into the scratch tree the
     * inlined bootstrap resolves it and the compatibility gate runs off that copy (`compat: ok`);
     * with nothing able to resolve it, the same bytes must still mount in full, printing the
     * `envinit: WARNING` — the family's degrade rule, "no base → still mounts". Peers are the
     * installed dsh copies an explicit `<scratch>/node_modules` link makes, `--runtime` semantics.
     */
    function mountVariant(label, { linkBase }) {
      const scratch = mkdtempSync(join(tmpdir(), 'avf-mission-pack-mount-'))
      const scope = join(scratch, 'node_modules', '@avantf')
      mkdirSync(scope, { recursive: true })
      console.log(`\n▶ [${label}] extract ${packedTarball}\n  → ${join(scope, 'dsh-mission')}`)
      if (spawnSync('tar', ['-xzf', packedTarball, '-C', scope], { stdio: 'inherit' }).status !== 0) {
        failures.push(`${label}: cannot extract ${packedTarball}`)
        if (keep) console.log(`  scratch[${label}] kept: ${scratch}`)
        else rmSync(scratch, { recursive: true, force: true })
        return
      }
      renameSync(join(scope, 'package'), join(scope, 'dsh-mission'))
      // The runtime externals an npm install would have put beside the package. Every `@avantf/*`
      // ENGINE name stays unlinked on purpose: the core is inlined, so a leaked engine import must
      // fail to resolve — that is what makes this mount a self-containment proof.
      const peerScope = join(scratch, 'node_modules', '@deepseek-ai')
      mkdirSync(peerScope, { recursive: true })
      for (const name of readdirSync(linkedPeers)) {
        symlinkSync(join(linkedPeers, name), join(peerScope, name), 'dir')
      }
      symlinkSync(join(pluginDir, 'node_modules', 'zod'), join(scratch, 'node_modules', 'zod'), 'dir')
      // The base PEER: linked (resolvable) or absent (unresolvable), never both — the variant's
      // whole point is which of the two bootstrap paths runs.
      if (linkBase) {
        const from = join(pluginDir, 'node_modules', '@avantf', 'dsh-plugin-base')
        if (!existsSync(from)) {
          failures.push(`${label}: @avantf/dsh-plugin-base is not installed here — cannot prove the base-resolvable mount`)
          if (keep) console.log(`  scratch[${label}] kept: ${scratch}`)
          else rmSync(scratch, { recursive: true, force: true })
          return
        }
        symlinkSync(from, join(scratch, 'node_modules', '@avantf', 'dsh-plugin-base'), 'dir')
      }
      const status = spawnSync(process.execPath, [join(repo, 'scripts', 'mount-smoke.mjs'), '--runtime'], {
        stdio: 'inherit',
        env: {
          ...process.env,
          AVANTF_PLUGIN_DIR: join(scope, 'dsh-mission'),
          AVANTF_MOUNT_SCRATCH: scratch,
          // No base linked: the smoke must assert the base-unavailable WARNING and still mount.
          ...(linkBase ? {} : { AVANTF_COMPAT_ABSENT: '1' }),
        },
      }).status
      if (status !== 0) {
        failures.push(`the packed tarball did not mount [${label}] (see the mount smoke output above)`)
        if (keep) console.log(`  scratch[${label}] kept: ${scratch}`)
        else rmSync(scratch, { recursive: true, force: true })
      } else {
        rmSync(scratch, { recursive: true, force: true })
      }
    }

    // The two bootstrap paths a user's install can take.
    mountVariant('base linked', { linkBase: true })
    mountVariant('base unresolvable', { linkBase: false })
  }
}

if (failures.length > 0) {
  console.error(`\npack:plugin FAILED (${String(failures.length)})`)
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}
console.log(`\npack:plugin ok → ${outDir}`)
for (const tarball of tarballs) console.log(`  ${tarball}`)
if (mount) {
  console.log(`\n✓ PACK OK — the packed tarball mounts in a scratch profile: ${join(outDir, tarballs[0])}`)
}
