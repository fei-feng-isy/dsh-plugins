#!/usr/bin/env node
/**
 * Vendor `@avantf/dsh-plugin-base`'s bootstrap into a plugin tree, from the base the plugin actually
 * loads — ONE implementation for both trees.
 *
 * The base is each plugin's plain runtime **dependency** (`dependencies`, the same wide range in both
 * trees) and a **published package**. In this workspace pnpm links `base/plugin-base` into
 * `<tree>/packages/plugin/node_modules/@avantf/dsh-plugin-base` (the plugin also declares the same
 * range in `devDependencies`, which is what makes that link resolve), and that linked, built copy is
 * what a build is checked against. One piece is INLINED:
 *
 *   1. `packages/plugin/node_modules/@avantf/dsh-plugin-base` is the source of truth, so
 *      `await import('@avantf/dsh-plugin-base')` resolves (the normal path);
 *   2. `dist/bootstrap.js` + `dist/bootstrap.d.ts` are copied into the plugin's `src/` — the inlined
 *      loader is a **copied file** imported by relative path, not a bundle. mem's bundler carries it
 *      into `lib/index.js`; mission is `tsc`-only and ships it beside the entry.
 *
 * **Co-developing the base elsewhere** is an explicit opt-in: `DSH_ENVINIT=<dir>` vendors from that
 * directory in place of the workspace link. Nothing is discovered implicitly — a directory only
 * counts when it is the base (its `package.json` is named `@avantf/dsh-plugin-base`) and has a built
 * `dist/bootstrap.js`.
 *
 * `--check` reports a missing link, an opt-in that drifted, a vendored copy that drifted, a vendored
 * copy outside the declared dependency range, and a stale baked interface record as separate problems
 * with separate fixes (`pnpm install` for the first, this script for the rest). The drift check
 * compares the vendored files BYTE-FOR-BYTE with the base's (minus the source-map comment), not just
 * the `VERSION` constant: a stale build or a hand edit must not pass a version check.
 *
 *   node scripts/link-envinit.mjs            # vendor from the workspace link (or the DSH_ENVINIT opt-in)
 *   node scripts/link-envinit.mjs --check    # verify only, change nothing
 *
 * The two trees used to carry a copy each, and the copies had drifted: one required the base to live
 * inside the workspace, the other accepted a registry install whose boundary was only the parent
 * directory; one checked the vendored bootstrap against the declared dependency range, the other did
 * not.
 * This module is the union: the workspace boundary is FOUND (walking up to `pnpm-workspace.yaml`, so
 * a nested tree still resolves the real workspace root), and the dependency-range check runs for both.
 *
 * @module scripts/lib/link-envinit
 */
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

import { readBootstrapVersion } from './bootstrap-version.mjs'
import {
  INTERFACE_VERSION_FILE,
  bakeInterfaceVersion,
  interfaceVersionText,
  readBaseInterfaceVersion,
  readBasePackageVersion,
  readInterfaceVersion,
} from './interface-version.mjs'

/** The one package this script vendors. */
export const PACKAGE = '@avantf/dsh-plugin-base'

/**
 * The merged workspace root: the nearest ancestor with a `pnpm-workspace.yaml`. The base lives at
 * `<workspace root>/base/plugin-base`, i.e. a SIBLING of the plugin trees, so "inside the repo" has
 * to mean the workspace — not the tree's own directory, or the legitimate workspace link would read
 * as a stray checkout. A tree checked out alone (no workspace above it) falls back to itself.
 */
export function findWorkspaceRoot(from) {
  let current = from
  for (;;) {
    if (existsSync(join(current, 'pnpm-workspace.yaml'))) return current
    const parent = dirname(current)
    if (parent === current) return from
    current = parent
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

/** The `lstat` of a path, or `undefined` when it is absent. */
function lstatOrUndefined(path) {
  try {
    return lstatSync(path)
  } catch {
    return undefined
  }
}

/**
 * Run the vendor/check step for one tree.
 * @param options.repo - the plugin tree root (`<repo>/mem` or `<repo>/mission`).
 * @param options.argv - defaults to `process.argv.slice(2)`.
 * @param options.env - defaults to `process.env` (the `DSH_ENVINIT` opt-in is read from here).
 * @returns the process exit code.
 */
export async function runLinkEnvinit({ repo, argv = process.argv.slice(2), env = process.env }) {
  const pluginDir = join(repo, 'packages', 'plugin')
  const linkPath = join(pluginDir, 'node_modules', '@avantf', 'dsh-plugin-base')
  const vendoredJs = join(pluginDir, 'src', 'envinit-bootstrap.js')
  const vendoredDts = join(pluginDir, 'src', 'envinit-bootstrap.d.ts')
  const workspaceRoot = findWorkspaceRoot(repo)

  const check = argv.includes('--check')
  const optIn = env['DSH_ENVINIT']

  /** A directory counts when it is the base package and has a built bootstrap. */
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

  /** Whether a resolved base directory lives inside this workspace (which the workspace link does). */
  function insideWorkspace(target) {
    const root = safeRealpath(workspaceRoot) ?? workspaceRoot
    return target === root || target.startsWith(root + sep)
  }

  /** How the base link slot reads, for the one failure block that has to explain it. */
  function describeLink(kind, target) {
    if (kind === undefined) return 'missing'
    if (target !== undefined && !insideWorkspace(target)) return `a link to ${target} (a checkout outside this workspace, not the base link)`
    return target === undefined || !frameworkAt(target) ? 'not a built @avantf/dsh-plugin-base' : target
  }

  /**
   * The directory `DSH_ENVINIT` explicitly asks for, or `undefined`. Co-development elsewhere is
   * opt-in: an unrelated directory must never silently become the source of a build. A named
   * directory that is not a built base is a misconfiguration, not a missing one.
   */
  const checkout = optIn === undefined ? undefined : resolve(optIn)
  if (checkout !== undefined && !frameworkAt(checkout)) {
    console.error(`link-envinit: DSH_ENVINIT=${optIn} is not a built ${PACKAGE} checkout`)
    console.error(`  expected ${join(checkout, 'package.json')} to be ${PACKAGE} with dist/bootstrap.js`)
    return 1
  }

  /**
   * The workspace link at {@link linkPath}, or `undefined`.
   *
   * The link is whatever the package manager put there — under the isolated linker the base link is
   * `<workspace root>/base/plugin-base` (a SIBLING of the tree) or a symlink into
   * `<workspace root>/node_modules/.pnpm`, which is why "symlink" alone cannot mean "some other
   * checkout". The line is the WORKSPACE: a target outside it is a stray checkout a build must not
   * silently consume.
   */
  const linkKind = lstatOrUndefined(linkPath)
  const installTarget = safeRealpath(linkPath)
  const installed = installTarget !== undefined && frameworkAt(installTarget) && insideWorkspace(installTarget)
    ? installTarget
    : undefined

  const source = checkout ?? installed
  const mode = checkout === undefined ? 'installed' : 'checkout'

  if (source === undefined) {
    // One line per fact, one fix per reader. The consuming case (a published package this checkout has
    // not installed) is the common one and the only dead end if it is not the answer, so it leads.
    console.error(`link-envinit: cannot find ${PACKAGE} — the workspace link is not in place (is the base built?)`)
    console.error(`  ${linkPath}: ${describeLink(linkKind, installTarget)}`)
    console.error('  fix: pnpm install && pnpm --filter @avantf/dsh-plugin-base run build')
    if (optIn === undefined) {
      console.error('  vendoring a base elsewhere instead: DSH_ENVINIT=<dir> node scripts/link-envinit.mjs')
    }
    return 1
  }

  const version = readManifest(source)?.version
  if (typeof version !== 'string') {
    console.error(`link-envinit: ${join(source, 'package.json')} has no version`)
    return 1
  }

  if (check) {
    /** `fix` is the command that actually resolves the finding, not just this script's name. */
    const problems = []
    // The link finding is CHECKOUT-only: in installed mode the install IS the source, and a symlink
    // there never reaches this block (it exits above as "not in place"). Its fix is this script.
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
      problems.push({ text: `vendored bootstrap declares ${vendored} but the ${mode} is ${version}`, fix: 'node scripts/link-envinit.mjs' })
    }
    // The version constant is NOT enough on its own: two builds of the same version differ, so a stale
    // or hand-edited copy of ANY build passes it. The copy is verbatim minus the source-map comment, so
    // compare BYTES — the same discipline the vendored dsh-client-preset gets, and the only thing that
    // catches an edit made without re-running this script.
    if (vendored !== undefined && !readFileSync(vendoredJs).equals(vendoredBytes(join(source, 'dist', 'bootstrap.js')))) {
      problems.push({ text: `${vendoredJs} differs byte-for-byte from the ${mode}'s dist/bootstrap.js`, fix: 'node scripts/link-envinit.mjs' })
    }
    if (!existsSync(vendoredDts)) {
      problems.push({ text: `${vendoredDts} is missing`, fix: 'node scripts/link-envinit.mjs' })
    } else if (!readFileSync(vendoredDts).equals(vendoredBytes(join(source, 'dist', 'bootstrap.d.ts')))) {
      problems.push({ text: `${vendoredDts} differs byte-for-byte from the ${mode}'s dist/bootstrap.d.ts`, fix: 'node scripts/link-envinit.mjs' })
    }
    // Matching the installed copy is not the same as BEING INSTALLABLE. The plugin declares the base
    // as a plain runtime DEPENDENCY range, and `linkWorkspacePackages` links past it: when the base
    // cuts a minor the workspace keeps linking it, this script keeps vendoring it byte-for-byte, and
    // the only thing that notices is a run-time `envinit: WARNING`. The check uses the base's OWN
    // semver implementation rather than a second copy of the range grammar (`./semver` is not an
    // exported subpath, so it is loaded by path).
    if (vendored !== undefined) {
      const declared = readManifest(pluginDir)?.dependencies?.[PACKAGE]
      try {
        const { satisfiesRange } = await import(pathToFileURL(join(source, 'dist', 'semver.js')).href)
        if (typeof declared !== 'string' || declared === '' || !satisfiesRange(vendored, declared)) {
          problems.push({
            text: `vendored bootstrap ${vendored} is outside the declared dependency range ${String(declared)}; `
              + 'this plugin would mount with only a WARNING (a base minor moved past the range)',
            fix: `widen dependencies["${PACKAGE}"] to admit ${vendored} (and re-check the adapter surface)`,
          })
        }
      } catch (error) {
        problems.push({
          text: `cannot check the vendored bootstrap against the declared dependency range (${error instanceof Error ? error.message : String(error)})`,
          fix: 'pnpm --filter @avantf/dsh-plugin-base run build',
        })
      }
    }
    // The interface version travels in the artifact, not only in the vendored bootstrap: the gate must
    // be able to say "this build was written for generation N" even if the baked record is the only
    // thing that survived. `--check` compares BYTES with what a fresh bake would write, so a base that
    // moved its INTERFACE_VERSION (or its package version) is caught here, before a build ships the old
    // number.
    const bakedUrl = pathToFileURL(join(pluginDir, 'lib', INTERFACE_VERSION_FILE))
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
      if (expected !== undefined && existsSync(bakedUrl) && readFileSync(bakedUrl, 'utf8') !== expected) {
        problems.push({
          text: `${bakedUrl.pathname} does not match the ${mode} (${INTERFACE_VERSION_FILE} is stale)`,
          fix: 'node scripts/link-envinit.mjs',
        })
      }
    }
    for (const problem of problems) console.error(`  FAIL ${problem.text}\n       fix: ${problem.fix}`)
    if (problems.length > 0) return 1
    console.log(`link-envinit: ok — ${PACKAGE}@${version} (${mode}: ${source})`)
    return 0
  }

  console.log(`base: ${source} (${version}) — ${mode}`)

  // 1. the workspace link — only for the explicit co-development opt-in. Without one, the workspace link
  //    stays exactly as pnpm left it and is the base.
  if (checkout !== undefined) {
    mkdirSync(dirname(linkPath), { recursive: true })
    rmSync(linkPath, { recursive: true, force: true })
    symlinkSync(checkout, linkPath, 'dir')
    console.log(`linked ${linkPath}`)
  }

  // 2. the vendored bootstrap — the one piece a plugin inlines.
  //
  // The source-map comment is stripped: the base's `dist/bootstrap.js` points at `bootstrap.js.map`,
  // which we do not vendor (this is a copied blob, never a build input), and a dangling reference is
  // noise under vitest and in stack traces. Everything else is verbatim, so a drift check by content
  // still means "this is the base's file".
  mkdirSync(dirname(vendoredJs), { recursive: true })
  copyTextIfChanged(join(source, 'dist', 'bootstrap.js'), vendoredJs)
  copyTextIfChanged(join(source, 'dist', 'bootstrap.d.ts'), vendoredDts)
  console.log(`vendored bootstrap ${String(readBootstrapVersion(vendoredJs))} → src/envinit-bootstrap.{js,d.ts}`)

  if (readBootstrapVersion(vendoredJs) !== version) {
    console.error(`link-envinit: the vendored bootstrap declares ${String(readBootstrapVersion(vendoredJs))}, the ${mode} is ${version}`)
    console.error('  the copy is verbatim, so this means the base was built from a mismatched source tree')
    return 1
  }

  // 3. the interface version, baked beside the entry. Re-baking rides THIS step (with the vendoring)
  //    rather than a human remembering to run it: `pnpm build:dsh` already runs this script, and the
  //    gate is worthless if the baked number can silently go stale. It lands in `lib/`, next to
  //    `lib/index.js` — the file the runtime reads it back from — because the two halves must ship
  //    together.
  try {
    const baked = await bakeInterfaceVersion(pluginDir, source)
    console.log(`baked interface version ${String(baked.interfaceVersion)} (base ${baked.baseVersion}) → lib/${INTERFACE_VERSION_FILE}${baked.changed ? '' : ' (unchanged)'}`)
  } catch (error) {
    console.error(`link-envinit: cannot bake the interface version (${error instanceof Error ? error.message : String(error)})`)
    return 1
  }
  return 0

  /** Drop a trailing `//# sourceMappingURL=…` comment (and the newline it sat on). */
  function stripSourceMap(text) {
    return text.replace(/\n?\/\/# sourceMappingURL=\S*\s*$/u, '\n')
  }

  /** The bytes the vendoring writes for a framework file — one transform, used by the copy AND the check. */
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
}
