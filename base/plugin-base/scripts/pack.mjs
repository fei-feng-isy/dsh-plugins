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

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(repo, 'release')
rmSync(outDir, { recursive: true, force: true })
mkdirSync(outDir, { recursive: true })

const manifest = JSON.parse(readFileSync(join(repo, 'package.json'), 'utf8'))
const failures = []
const check = (condition, message) => {
  if (!condition) failures.push(message)
}

const packed = spawnSync('pnpm', ['pack', '--pack-destination', outDir], { cwd: repo, stdio: 'inherit', env: process.env })
check(packed.status === 0, 'pnpm pack failed')

const tarballs = readdirSync(outDir).filter(file => file.endsWith('.tgz'))
const expected = `${String(manifest.name).replace('@', '').replace('/', '-')}-${String(manifest.version)}.tgz`
check(tarballs.length === 1, `expected 1 tarball, found ${String(tarballs.length)}`)
check(tarballs[0] === expected, `tarball name ${String(tarballs[0])} does not match ${expected}`)

for (const tarball of tarballs) {
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
  check(/supportedRange = '[~^]?\d+\.\d+\.\d+'/.test(bootstrap), `${tarball}: dist/bootstrap.js does not bake a supportedRange`)
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
