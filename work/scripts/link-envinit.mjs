#!/usr/bin/env node
/**
 * Vendor `@avantf/dsh-plugin-base`'s bootstrap into the plugin, from the framework the plugin loads:
 * the registry install (a published package, so `pnpm install` fetches it) unless the explicit
 * `DSH_ENVINIT=<checkout>` opt-in names a checkout — nothing is discovered implicitly.
 *
 *   node scripts/link-envinit.mjs [--check]   # --check verifies only, changing nothing
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import { readBootstrapVersion } from '../../scripts/lib/bootstrap-version.mjs'
import {
  INTERFACE_VERSION_FILE,
  bakeInterfaceVersion,
  interfaceVersionText,
  readBaseInterfaceVersion,
  readBasePackageVersion,
  readInterfaceVersion,
} from '../../scripts/lib/interface-version.mjs'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pluginDir = join(repo, 'packages', 'plugin')
const linkPath = join(pluginDir, 'node_modules', '@avantf', 'dsh-plugin-base')
const vendoredJs = join(pluginDir, 'src', 'envinit-bootstrap.js')
const vendoredDts = join(pluginDir, 'src', 'envinit-bootstrap.d.ts')
const PACKAGE = '@avantf/dsh-plugin-base'

const check = process.argv.includes('--check')
const optIn = process.env['DSH_ENVINIT']

/** A directory counts when it is the framework package and has a built bootstrap. */
function frameworkAt(dir) {
  const manifest = join(dir, 'package.json')
  if (!existsSync(manifest) || !existsSync(join(dir, 'dist', 'bootstrap.js'))) return false
  return readManifest(dir)?.name === PACKAGE
}

/** The manifest of a package directory, or `undefined` when it is absent or unreadable. */
function readManifest(dir) {
  try {
    return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  } catch {
    return undefined
  }
}

/** `realpathSync` that answers `undefined` for a broken link instead of throwing. */
function safeRealpath(path) {
  try {
    return realpathSync(path)
  } catch {
    return undefined
  }
}

/**
 * The boundary a legitimate framework copy may live in.
 *
 * After the merge the family lives in ONE workspace: `base/plugin-base` is a sibling of `work/`, not
 * a directory inside it, and the package manager links it there — so "inside `work/`" would reject
 * the workspace's own base as an outside checkout. The boundary is therefore the enclosing workspace:
 * the parent directory when THAT holds a `pnpm-workspace.yaml` (the merged layout), else this
 * package's own directory (checked out alone). A copied-in sibling checkout is still rejected.
 */
const boundary = existsSync(join(dirname(repo), 'pnpm-workspace.yaml')) ? dirname(repo) : repo

/** Whether a resolved framework directory lives inside this workspace's own install tree. */
function insideRepo(target) {
  const root = safeRealpath(boundary) ?? boundary
  return target === root || target.startsWith(root + sep)
}

/** The `lstat` of a path, or `undefined` when it is absent. */
function lstatOrUndefined(path) {
  try {
    return lstatSync(path)
  } catch {
    return undefined
  }
}

/** How the framework install slot reads, for the one failure block that has to explain it. */
function describeLink(kind, target) {
  if (kind === undefined) return 'missing'
  if (target !== undefined && !insideRepo(target)) return `a link to ${target} (a checkout outside this repo, not the install)`
  return target === undefined || !frameworkAt(target) ? 'not a built @avantf/dsh-plugin-base' : target
}

/**
 * The checkout `DSH_ENVINIT` explicitly asks for, or `undefined`; a named directory that is not a
 * built framework is a misconfiguration, not a missing one.
 */
const checkout = optIn === undefined ? undefined : resolve(optIn)
if (checkout !== undefined && !frameworkAt(checkout)) {
  console.error(`link-envinit: DSH_ENVINIT=${optIn} is not a built ${PACKAGE} checkout`)
  console.error(`  expected ${join(checkout, 'package.json')} to be ${PACKAGE} with dist/bootstrap.js`)
  process.exit(1)
}

/**
 * The registry install at {@link linkPath}, or `undefined`. The REPOSITORY is the line: a target
 * outside it is a sibling checkout, which only the explicit `DSH_ENVINIT` opt-in links and which a
 * build must not silently keep using.
 */
const linkKind = lstatOrUndefined(linkPath)
const installTarget = safeRealpath(linkPath)
const installed = installTarget !== undefined && frameworkAt(installTarget) && insideRepo(installTarget)
  ? installTarget
  : undefined

const source = checkout ?? installed
const mode = checkout === undefined ? 'installed' : 'checkout'

if (source === undefined) {
  // One line per fact, one fix per reader; the consuming case (a published package this checkout has not installed) leads.
  console.error(`link-envinit: cannot find ${PACKAGE} — the registry install is not in place`)
  console.error(`  ${linkPath}: ${describeLink(linkKind, installTarget)}`)
  console.error('  fix: pnpm install')
  if (optIn === undefined) {
    console.error('  co-developing the framework instead: DSH_ENVINIT=<checkout> node scripts/link-envinit.mjs')
  }
  process.exit(1)
}

const version = readManifest(source)?.version
if (typeof version !== 'string') {
  console.error(`link-envinit: ${join(source, 'package.json')} has no version`)
  process.exit(1)
}

if (check) {
  /** `fix` is the command that actually resolves the finding, not just this script's name. */
  const problems = []
  // The link finding is CHECKOUT-only: in installed mode the install IS the source, and a symlink there never reaches this block (it exits above as "not in place").
  if (mode === 'checkout') {
    if (installTarget === undefined) {
      problems.push({ text: `${linkPath} is missing or a broken link`, fix: 'node scripts/link-envinit.mjs' })
    } else if (installTarget !== realpathSync(checkout)) {
      problems.push({ text: `${linkPath} points at ${installTarget}, not the DSH_ENVINIT checkout ${checkout}`, fix: 'node scripts/link-envinit.mjs' })
    }
  }
  const vendored = existsSync(vendoredJs) ? readBootstrapVersion(vendoredJs) : undefined
  if (vendored === undefined) {
    problems.push({ text: `${vendoredJs} is missing`, fix: 'node scripts/link-envinit.mjs' })
  } else if (vendored !== version) {
    problems.push({ text: `vendored bootstrap is ${vendored} but the ${mode} is ${version}`, fix: 'node scripts/link-envinit.mjs' })
  }
  // The version constant is NOT enough on its own: two builds of the same version differ, so a stale
  // or hand-edited copy of ANY build passes it. What is vendored is `dist/bootstrap.js` verbatim
  // minus the source-map comment, so compare BYTES — the same discipline the vendored harness preset
  // gets, and the only thing that catches an edit made without re-running this script.
  if (vendored !== undefined && !readFileSync(vendoredJs).equals(vendoredBytes(join(source, 'dist', 'bootstrap.js')))) {
    problems.push({ text: `${vendoredJs} differs byte-for-byte from the ${mode}'s dist/bootstrap.js`, fix: 'node scripts/link-envinit.mjs' })
  }
  if (!existsSync(vendoredDts)) {
    problems.push({ text: `${vendoredDts} is missing`, fix: 'node scripts/link-envinit.mjs' })
  } else if (!readFileSync(vendoredDts).equals(vendoredBytes(join(source, 'dist', 'bootstrap.d.ts')))) {
    problems.push({ text: `${vendoredDts} differs byte-for-byte from the ${mode}'s dist/bootstrap.d.ts`, fix: 'node scripts/link-envinit.mjs' })
  }
  // Matching the installed copy is not the same as BEING INSTALLABLE. The plugin declares a peer
  // range, and `linkWorkspacePackages` links past it: when base cuts a minor (0.1.x → 0.2.0) the
  // workspace keeps linking it, this script keeps vendoring it byte-for-byte, and the only thing that
  // notices is a run-time `envinit: WARNING` when the baked `supportedRange` rejects the version. The
  // base's own preset checks this (`bootstrap-version-in-range`); this plugin does not use that
  // preset, so it checks the one line it needs — with the base's OWN semver implementation rather
  // than a third copy of the range grammar (`./semver` is not an exported subpath, so it is loaded by
  // path, the same way this script already reads base's `dist/` directly).
  if (vendored !== undefined) {
    const declared = readManifest(pluginDir)?.peerDependencies?.[PACKAGE]
    const { satisfiesRange } = await import(pathToFileURL(join(source, 'dist', 'semver.js')).href)
    if (typeof declared !== 'string' || declared === '' || !satisfiesRange(vendored, declared)) {
      problems.push({
        text: `vendored bootstrap ${vendored} is outside the declared peer range ${String(declared)}; `
          + `this plugin would mount with only a WARNING (a base minor moved past its peer)`,
        fix: `widen peerDependencies["${PACKAGE}"] to admit ${vendored} (and re-check the adapter surface)`,
      })
    }
  }
  // The interface version travels in the artifact, not only in the vendored bootstrap: the runtime gate
  // must be able to say "this build was written for generation N" even if the baked record is the only
  // thing that survived. `--check` compares BYTES with what a fresh bake would write, so a base that
  // moved its INTERFACE_VERSION (or its package version) is caught before a build ships the old number.
  const bakedUrl = new URL(`../packages/plugin/lib/${INTERFACE_VERSION_FILE}`, import.meta.url)
  const baked = readInterfaceVersion(bakedUrl)
  if (baked === undefined) {
    problems.push({ text: `${bakedUrl.pathname} is missing or malformed`, fix: 'node scripts/link-envinit.mjs' })
  } else {
    let expected
    try {
      expected = interfaceVersionText(readBasePackageVersion(source), await readBaseInterfaceVersion(source))
    } catch (error) {
      problems.push({ text: `cannot read the ${mode}'s interface version (${error instanceof Error ? error.message : String(error)})`, fix: 'pnpm --filter @avantf/dsh-plugin-base run build' })
    }
    if (expected !== undefined && readFileSync(bakedUrl, 'utf8') !== expected) {
      problems.push({
        text: `${bakedUrl.pathname} does not match the ${mode} (${INTERFACE_VERSION_FILE} is stale)`,
        fix: 'node scripts/link-envinit.mjs',
      })
    }
  }
  for (const problem of problems) console.error(`  FAIL ${problem.text}\n       fix: ${problem.fix}`)
  if (problems.length > 0) process.exit(1)
  console.log(`link-envinit: ok — ${PACKAGE}@${version} (${mode}: ${source})`)
  process.exit(0)
}

console.log(`framework: ${source} (${version}) — ${mode}`)

// 1. the peer link — only for the explicit co-development opt-in; without one the registry install stays exactly as pnpm left it.
if (checkout !== undefined) {
  mkdirSync(dirname(linkPath), { recursive: true })
  rmSync(linkPath, { recursive: true, force: true })
  symlinkSync(checkout, linkPath, 'dir')
  console.log(`linked ${linkPath}`)
}

// 2. the vendored bootstrap — the one piece this plugin inlines: this plugin is `tsc`-only, so the
//    framework's `dist/bootstrap.js` + `.d.ts` are copied into `src/` and imported by relative path.
//    The source-map comment is stripped (the `.map` is not vendored, so the reference would dangle);
//    everything else is verbatim, so a content drift check still means "this is the framework's file".
mkdirSync(dirname(vendoredJs), { recursive: true })
copyTextIfChanged(join(source, 'dist', 'bootstrap.js'), vendoredJs)
copyTextIfChanged(join(source, 'dist', 'bootstrap.d.ts'), vendoredDts)
console.log(`vendored bootstrap ${String(readBootstrapVersion(vendoredJs))} → src/envinit-bootstrap.{js,d.ts}`)

if (readBootstrapVersion(vendoredJs) !== version) {
  console.error(`link-envinit: the vendored bootstrap declares ${String(readBootstrapVersion(vendoredJs))}, the ${mode} is ${version}`)
  console.error('  the copy is verbatim, so this means the framework was built from a mismatched source tree')
  process.exit(1)
}

// 3. the interface version, baked beside the entry. Re-baking rides THIS step (with the vendoring)
//    rather than a human remembering to run it: `pnpm build:dsh` already runs this script, and the
//    gate is worthless if the baked number can silently go stale. It lives in `lib/` because that is
//    the directory the published package ships and `lib/index.js` is the module that reads it back.
try {
  const baked = await bakeInterfaceVersion(pluginDir, source)
  console.log(`baked interface version ${String(baked.interfaceVersion)} (base ${baked.baseVersion}) → lib/${INTERFACE_VERSION_FILE}${baked.changed ? '' : ' (unchanged)'}`)
} catch (error) {
  console.error(`link-envinit: cannot bake the interface version (${error instanceof Error ? error.message : String(error)})`)
  process.exit(1)
}

/** Drop a trailing `//# sourceMappingURL=…` comment (and the newline it sat on). */
function stripSourceMap(text) {
  return text.replace(/\n?\/\/# sourceMappingURL=\S*\s*$/u, '\n')
}

/** The bytes vendoring writes for a framework file — one transform, shared by the copy AND the check. */
function vendoredBytes(from) {
  return Buffer.from(stripSourceMap(readFileSync(from, 'utf8')), 'utf8')
}

/** Copy a framework file into the plugin tree, skipping when the bytes are identical (no mtime churn). */
function copyTextIfChanged(from, to) {
  const next = vendoredBytes(from)
  try {
    if (readFileSync(to).equals(next)) return
  } catch {
    // Not there yet.
  }
  writeFileSync(to, next)
}
