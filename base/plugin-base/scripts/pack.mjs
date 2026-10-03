#!/usr/bin/env node
/**
 * Pack the publishable tarball and check its content.
 *
 * The tarball is what a consumer actually gets, so the checks are about it: the version baked into
 * `dist/bootstrap.js` must match `package.json`, the framework must still be self-contained, and
 * every entry point must be present.
 */
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { spawnToolSync } from '../../../scripts/lib/win-spawn.mjs'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(repo, 'release')
rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })

const manifest = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'))
const failures = []
const check = (condition, message) => {
  if (!condition) failures.push(message)
}

// `spawnToolSync('pnpm', …)`, not a bare `spawnSync`: on win32 `pnpm` is a `.cmd` shim and Node refuses
// the no-shell spawn of one (CVE-2024-27980), so a bare call is EINVAL there. The shared helper turns
// it into `cmd.exe /c pnpm.cmd pack --pack-destination <outDir>` (no Node-side shell, no DEP0190), the
// shape pinned from Linux in `scripts/check-dsh-lines.test.mjs`. `[win]` — the shape is asserted
// there; a real Windows box still has to confirm the launch end to end.
const packed = spawnToolSync('pnpm', ['pack', '--pack-destination', outDir], { cwd: repo, stdio: 'inherit', env: process.env })
check(packed.status === 0, 'pnpm pack failed')

// The npm page is the package's OWN README: it is in the required-entry list above, and its title has
// to name THIS package — a copy/rename slip would otherwise publish the wrong page.
function assertReadmeTitle(tarball) {
  const readme = spawnSync('tar', ['-xzOf', join(outDir, tarball), 'package/README.md'], { encoding: 'utf8' }).stdout ?? ''
  const first = readme.split('\n')[0]?.trim() ?? ''
  check(first === `# ${String(manifest.name)}`, `README.md starts with ${JSON.stringify(first)}, expected "# ${String(manifest.name)}"`)
}

const tarballs = readdirSync(outDir).filter(file => file.endsWith('.tgz'))
const expected = `${String(manifest.name).replace('@', '').replace('/', '-')}-${String(manifest.version)}.tgz`
check(tarballs.length === 1, `expected 1 tarball, found ${String(tarballs.length)}`)
check(tarballs[0] === expected, `tarball name ${String(tarballs[0])} does not match ${expected}`)

for (const tarball of tarballs) {
  assertReadmeTitle(tarball)
  const listing = spawnSync('tar', ['-tzf', join(outDir, tarball)], { encoding: 'utf8' }).stdout ?? ''
  for (const entry of [
    'package/package.json',
    'package/README.md',
    'package/LICENSE',
    'package/dist/index.js',
    'package/dist/bootstrap.js',
    'package/dist/preset.js',
    'package/dist/conformance.js',
    'package/dist/internal.js',
    'package/dist/compat.js',
    // The shared KIT. It ships in THIS package (not as a package of its own) precisely so that a
    // change to a shared helper is one base release — so its entry points must be in the tarball.
    'package/dist/kit/index.js',
    'package/dist/kit/prompt_files.js',
    'package/dist/kit/logger.js',
    'package/dist/kit/typert.js',
    'package/dist/kit/family.js',
    'package/dist/cli.js',
  ]) {
    check(listing.includes(entry), `${tarball}: missing ${entry}`)
  }

  // Publish-artifact size gate: the tarball must carry NO JS source map.
  //
  // `dist` is built with `sourceMap: true` on purpose — local dev/debugging wants the maps — and they
  // are dropped from the PUBLISHED artifact by the `!dist/**/*.js.map` entries in package.json#files
  // (the same mechanism the two plugins use; both already ship zero `.js.map`). The assertion is made
  // on the tarball rather than on the tsconfig/`files` pair because only the tarball proves what a
  // consumer actually gets. What it defends against:
  //   - the maps are the biggest avoidable chunk of the artifact — 34 files, 272,560 B of the 845,992 B
  //     unpacked (≈32%; 331,930 B ≈ 39% together with the `.d.ts` maps), and
  //   - their `sources` point at `../src/**`, which does NOT ship (`files: ["dist"]`), so a consumer
  //     can never resolve them: they buy nothing while costing the download.
  // A silent regression (tsconfig or `files` edited) is exactly the thing this line catches.
  const jsMaps = listing.split('\n').filter(entry => /^package\/dist\/.*\.js\.map$/.test(entry))
  const jsMapBytes = jsMaps.reduce((sum, entry) => sum + (spawnSync('tar', ['-xzOf', join(outDir, tarball), entry]).stdout?.length ?? 0), 0)
  check(jsMaps.length === 0, `${tarball}: ships ${String(jsMaps.length)} JS source map(s) (${String(jsMapBytes)} bytes); keep the "!dist/**/*.js.map" negation in package.json#files`)

  const contents = spawnSync('tar', ['-xzOf', join(outDir, tarball), 'package/package.json'], { encoding: 'utf8' }).stdout ?? ''
  for (const protocol of ['workspace:', 'catalog:', 'link:', 'file:']) {
    check(!contents.includes(`"${protocol}`) && !contents.includes(`: "${protocol}`), `${tarball}: still declares ${protocol}`)
  }
  const parsed = JSON.parse(contents)
  check(parsed.version === manifest.version, `${tarball}: packed version ${String(parsed.version)} does not match ${String(manifest.version)}`)
  check(Object.keys(parsed.dependencies ?? {}).length === 0, `${tarball}: runtime dependencies must stay empty`)
  // The ONE peer is `zod`, and it is load-bearing: the compatibility gate lives in this same package
  // now and builds a live zod schema for its typert probe. The range serves both this workspace's
  // zod and the installed dsh's own copy (4.6.5). Any OTHER peer would be a second orchestrator.
  const peers = Object.keys(parsed.peerDependencies ?? {})
  check(peers.length === 1 && peers[0] === 'zod', `${tarball}: peerDependencies must be exactly ["zod"], found [${peers.join(', ')}]`)

  const bootstrap = spawnSync('tar', ['-xzOf', join(outDir, tarball), 'package/dist/bootstrap.js'], { encoding: 'utf8' }).stdout ?? ''
  check(bootstrap.includes(`VERSION = '${String(manifest.version)}'`), `${tarball}: dist/bootstrap.js does not bake VERSION ${String(manifest.version)}`)
  check(bootstrap.includes("PACKAGE = '@avantf/dsh-plugin-base'"), `${tarball}: dist/bootstrap.js does not resolve @avantf/dsh-plugin-base`)
  // The interval is now a plain comparator set (`>=0.3.0 <1.0.0`), so this cannot be a caret-shaped
  // regex: assert it is non-empty and names at least one complete version. What the interval MEANS is
  // checked where it belongs — `test/bootstrap.spec.ts` asserts `satisfiesRange(VERSION, supportedRange)`
  // against the real semver implementation, which a regex here could never do.
  const rangeMatch = /supportedRange = '([^']*)'/.exec(bootstrap)
  const range = rangeMatch?.[1]?.trim() ?? ''
  check(range !== '' && /\d+\.\d+\.\d+/.test(range), `${tarball}: dist/bootstrap.js does not bake a semver supportedRange (found ${JSON.stringify(range)})`)
  check(!/from ['"]\.\//.test(bootstrap) && !/require\(['"]\.\//.test(bootstrap), `${tarball}: dist/bootstrap.js must have no relative import`)
  for (const line of bootstrap.match(/from ['"][^'"]+['"]/g) ?? []) {
    check(line.includes('node:'), `${tarball}: dist/bootstrap.js imports a non-builtin (${line})`)
  }
}

if (failures.length > 0) {
  console.error(`\npack FAILED (${String(failures.length)})`)
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}
console.log(`\npack ok → ${join('release', tarballs[0] ?? '')}`)
