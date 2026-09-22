#!/usr/bin/env node
/**
 * Pack the plugin into ./release (`pnpm pack:plugin`) and assert the tarball is self-contained:
 * no bundled `@deepseek-ai/*` (all peers, keeping host identities single) and no reference to the
 * unpublished `@avantf/work-core`, whose runtime and declarations are inlined instead.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(repo, 'release')
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
    // `@avantf/work-core` is INTERNAL: nothing outside this workspace resolves the name, the
    // runtime is inlined into the entry, and the declarations are carried into `lib/work-core/`.
    if (pkg === '@avantf/work-core') {
      failures.push(types
        ? `${manifest.name}: ${relative(dir, file)} names @avantf/work-core — the core is not published, so its types must be carried into lib/work-core and repointed (see scripts/build.mjs inlineCoreTypes)`
        : `${manifest.name}: ${relative(dir, file)} imports @avantf/work-core at runtime — the host entry was not bundled (see scripts/build.mjs bundleHost)`)
      continue
    }
    if (!peers.has(pkg)) {
      failures.push(`${manifest.name}: ${relative(dir, file)} imports ${pkg} but it is not a declared peer`)
    }
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
      }
    }
  }

  // ── 4. pack ────────────────────────────────────────────────────────────────
  console.log(`\n▶ pack ${manifest.name}`)
  // `pnpm pack`, not `npm pack`: rewriting `catalog:` / `workspace:*` into registry ranges is
  // pnpm's work, and npm would pack a tarball nobody can install.
  const result = spawnSync('pnpm', ['pack', '--pack-destination', outDir], {
    cwd: dir,
    stdio: 'inherit',
    env: process.env,
  })
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
}

if (failures.length > 0) {
  console.error(`\npack:plugin FAILED (${String(failures.length)})`)
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}
console.log(`\npack:plugin ok → ${outDir}`)
for (const tarball of tarballs) console.log(`  ${tarball}`)
