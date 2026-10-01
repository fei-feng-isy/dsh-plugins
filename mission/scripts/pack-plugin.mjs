#!/usr/bin/env node
/**
 * Pack `@avantf/dsh-mission` into `./release` and assert the tarball is self-contained: no bundled
 * `@deepseek-ai/*` (all peers, keeping host identities single) and no reference to the unpublished
 * `@avantf/mission-core`, whose runtime and declarations are inlined instead.
 *
 * The ASSERTIONS live in `scripts/lib/pack-plugin.mjs` (shared with `mem/`, which runs the same
 * union — mem's stray/self-containment/`workspace:` checks and mission's shipped-file peer,
 * bake↔VERSION_PACKAGES and relative-closure checks). This file supplies mission's shape: the
 * bootstrap is a COPIED file (`lib/envinit-bootstrap.js`) the entry imports relatively, the engine's
 * declarations are carried into `lib/mission-core/`, and the gate's version list is `VERSION_PACKAGES`
 * in `src/envinit.ts`.
 *
 * Usage:
 *   pnpm pack:plugin               # pack into release/ + the static tarball assertions
 *   pnpm pack:plugin --mount       # + extract the tarball into a scratch profile and mount it
 *   pnpm pack:plugin --out <dir>   # pack destination (default: <repo>/release)
 *   pnpm pack:plugin --keep        # keep the scratch profile when --mount fails
 *
 * Run `pnpm build:dsh` first (this script never builds). `--mount` needs the installed dsh
 * (`npm i -g @deepseek-ai/dsh`), the peers a real profile resolves.
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { withWorkspaceVersions } from '../../scripts/lib/versions.mjs'
import { assertCheckout, assertTarball, clearTarballs, mountAllVariants, parsePackArgs, report } from '../../scripts/lib/pack-plugin.mjs'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pluginDir = join(repo, 'packages', 'plugin')
const manifest = JSON.parse(readFileSync(join(pluginDir, 'package.json'), 'utf8'))

const config = {
  repo,
  pluginDir,
  entry: 'lib/index.js',
  clientEntry: 'lib/client.js',
  /** mission is `tsc`-only: the bootstrap is a copied file imported by relative path. */
  bootstrap: 'copied',
  bootstrapFile: 'lib/envinit-bootstrap.js',
  /** The core's declarations are repointed and carried here. */
  carriedTypesDir: 'lib/mission-core',
  libAllow: /^package\/lib\/(index\.js|client\.js|envinit-bootstrap\.js|dsh-build\.json|interface-version\.json|types\/.*\.d\.ts(?:\.map)?|mission-core\/.*\.d\.ts)$/,
  requiredEntries: [
    'package/package.json',
    'package/lib/index.js',
    'package/lib/interface-version.json',
    'package/LICENSE',
    'package/README.md',
  ],
  versionPackagesFile: 'src/envinit.ts',
  /**
   * mission's `VERSION_PACKAGES` names every `@deepseek-ai/dsh-*` package `link-dsh` bakes, so the
   * bake and the gate's list must agree BOTH ways here: an unlisted bake entry would drift unnoticed.
   */
  allowBakedSuperset: false,
}

const { mount, keep, outDir } = parsePackArgs(process.argv.slice(2), { defaultOutDir: join(repo, 'release') })
clearTarballs(outDir)

const problems = [...assertCheckout(config).problems]

// ── pack ────────────────────────────────────────────────────────────────────────────────────────
console.log(`\n▶ pack ${manifest.name}`)
// `pnpm pack`, not `npm pack`: rewriting `catalog:` / `workspace:*` into registry ranges is pnpm's
// mission, and npm would pack a tarball nobody can install. The private workspace-protocol targets get
// their version MATERIALIZED around this call and lose it again right after, so a mission pack never
// stamps its version onto mem's manifests (the M7 defect).
const result = withWorkspaceVersions(resolve(repo, '..'), manifest.version, () =>
  spawnSync('pnpm', ['pack', '--pack-destination', outDir], { cwd: pluginDir, stdio: 'inherit', env: process.env }), { group: 'mission' })
if (result.status !== 0) problems.push(`${manifest.name}: npm pack failed`)

const tarballs = readdirSync(outDir).filter((file) => file.endsWith('.tgz'))
if (tarballs.length !== 1) problems.push(`expected 1 tarball, found ${String(tarballs.length)}`)
for (const name of tarballs) problems.push(...assertTarball(config, join(outDir, name)).problems)

// ── optional: mount the PACKED tarball in a scratch profile ───────────────────────────────────
// `--mount` proves the tarball itself — the bytes the registry would serve — can be loaded by a host.
// The extraction and the peer links live in the shared helper; the mount is the tree's own
// `scripts/mount-smoke.mjs`, pointed at the extracted package through the packed-artifact hooks.
const notes = []
if (mount && problems.length === 0) {
  const packedTarball = join(outDir, tarballs[0])
  const linkedPeers = join(pluginDir, 'node_modules', '@deepseek-ai')
  if (!existsSync(linkedPeers)) {
    problems.push(`${packedTarball}: the @deepseek-ai peers are not linked — run \`pnpm build:dsh\` (or node scripts/link-dsh.mjs) before --mount`)
  } else {
    mountAllVariants({
      tarball: packedTarball,
      repo,
      keep,
      fail: (message) => problems.push(message),
      note: (message) => notes.push(message),
      scratchPrefix: 'avf-mission-pack-mount-',
      smokeArgs: ['--runtime'],
      absentEnv: 'AVANTF_COMPAT_ABSENT',
      packageDirName: 'dsh-mission',
      prepare({ scratch, linkBase, fail }) {
        // The runtime externals an npm install would have put beside the package. Every `@avantf/*`
        // ENGINE name stays unlinked on purpose: the core is inlined, so a leaked engine import must
        // fail to resolve — that is what makes this mount a self-containment proof.
        const peerScope = join(scratch, 'node_modules', '@deepseek-ai')
        mkdirSync(peerScope, { recursive: true })
        for (const name of readdirSync(linkedPeers)) {
          symlinkSync(join(linkedPeers, name), join(peerScope, name), 'dir')
        }
        symlinkSync(join(pluginDir, 'node_modules', 'zod'), join(scratch, 'node_modules', 'zod'), 'dir')
        if (linkBase) {
          const from = join(pluginDir, 'node_modules', '@avantf', 'dsh-plugin-base')
          if (!existsSync(from)) {
            fail('@avantf/dsh-plugin-base is not installed here — cannot prove the base-resolvable mount')
            return false
          }
          symlinkSync(from, join(scratch, 'node_modules', '@avantf', 'dsh-plugin-base'), 'dir')
        }
        return true
      },
    })
  }
}

report(problems, notes, mount
  ? `PACK OK — the packed tarball mounts in a scratch profile: ${join(outDir, tarballs[0] ?? '')}`
  : `pack:plugin ok → ${outDir}`)
if (!mount) for (const name of tarballs) console.log(`  ${name}`)
