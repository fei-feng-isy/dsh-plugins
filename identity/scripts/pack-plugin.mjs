#!/usr/bin/env node
/**
 * Pack `@avantf/dsh-identity` into `./release` and assert the tarball is self-contained: no bundled
 * `@deepseek-ai/*` (all peers, keeping host identities single) and no reference to an unpublished
 * `@avantf/*` engine (this tree has none, and the gate asserts none appears).
 *
 * The ASSERTIONS live in `scripts/lib/pack-plugin.mjs` (shared with the sibling trees). This file
 * supplies identity's shape: the bootstrap is a COPIED file (`lib/envinit-bootstrap.js`) the entry
 * imports relatively, there is no engine to inline or carry, and the built-in preset `.md` assets are
 * the first non-README `.md` resources this family ships — so `requiredEntries` names every one of
 * them explicitly and `libAllow` admits exactly them.
 *
 * Usage:
 *   pnpm pack:plugin               # pack into release/ + the static tarball assertions
 *   pnpm pack:plugin --mount       # + extract the tarball into a scratch profile and mount it
 *   pnpm pack:plugin --out <dir>   # pack destination (default: <repo>/release)
 *   pnpm pack:plugin --keep        # keep the scratch profile when --mount fails
 *
 * Run `pnpm build:dsh` first (this script never builds).
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { withWorkspaceVersions } from '../../scripts/lib/versions.mjs'
import { spawnToolSync } from '../../scripts/lib/win-spawn.mjs'
import { assertCheckout, assertTarball, clearTarballs, mountAllVariants, parsePackArgs, report } from '../../scripts/lib/pack-plugin.mjs'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pluginDir = join(repo, 'packages', 'plugin')
const manifest = JSON.parse(readFileSync(join(pluginDir, 'package.json'), 'utf8'))

/** The built-in presets: id → locales. Kept beside the assertions so the list cannot drift from them. */
const PRESETS = {
  coder: ['zh', 'en'],
  assistant: ['zh', 'en'],
  analyst: ['zh', 'en'],
}
const FILES = ['IDENTITY', 'SOUL', 'RULES']

/** Every shipped preset resource, one tarball entry each. */
const presetEntries = Object.entries(PRESETS).flatMap(([id, locales]) =>
  locales.flatMap((locale) => FILES.map((file) => `package/lib/assets/presets/${id}/${locale}/${file}.md`)))

const config = {
  repo,
  pluginDir,
  entry: 'lib/index.js',
  clientEntry: 'lib/client.js',
  /** identity is `tsc`-only: the bootstrap is a copied file imported by relative path. */
  bootstrap: 'copied',
  bootstrapFile: 'lib/envinit-bootstrap.js',
  libAllow: /^package\/lib\/(index\.js|client\.js|envinit-bootstrap\.js|dsh-build\.json|interface-version\.json|types\/.*\.d\.ts(?:\.map)?|assets\/presets\/[a-z][a-z0-9-]*\/(?:zh|en)\/(?:IDENTITY|SOUL|RULES)\.md)$/,
  requiredEntries: [
    'package/package.json',
    'package/lib/index.js',
    'package/lib/interface-version.json',
    'package/LICENSE',
    'package/README.md',
    ...presetEntries,
  ],
  versionPackagesFile: 'src/versions.ts',
  /**
   * `VERSION_PACKAGES` names every `@deepseek-ai/dsh-*` package `link-dsh` bakes, so the bake and the
   * gate's list must agree BOTH ways here: an unlisted bake entry would drift unnoticed.
   */
  allowBakedSuperset: false,
}

const { mount, keep, outDir } = parsePackArgs(process.argv.slice(2), { defaultOutDir: join(repo, 'release') })
clearTarballs(outDir)

const problems = [...assertCheckout(config).problems]

// ── pack ────────────────────────────────────────────────────────────────────────────────────────
console.log(`\n▶ pack ${manifest.name}`)
// `pnpm pack`, not `npm pack`: rewriting `catalog:` / `workspace:*` into registry ranges is pnpm's
// mission, and npm would pack a tarball nobody can install.
const result = withWorkspaceVersions(resolve(repo, '..'), manifest.version, () =>
  spawnToolSync('pnpm', ['pack', '--pack-destination', outDir], { cwd: pluginDir, stdio: 'inherit', env: process.env }), { group: 'identity' })
if (result.status !== 0) problems.push(`${manifest.name}: npm pack failed`)

const tarballs = readdirSync(outDir).filter((file) => file.endsWith('.tgz'))
if (tarballs.length !== 1) problems.push(`expected 1 tarball, found ${String(tarballs.length)}`)
for (const name of tarballs) problems.push(...assertTarball(config, join(outDir, name)).problems)

// ── optional: mount the PACKED tarball in a scratch profile ───────────────────────────────────
// `--mount` proves the tarball itself — the bytes the registry would serve — can be loaded by a host.
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
      scratchPrefix: 'avf-identity-pack-mount-',
      smokeArgs: ['--runtime'],
      absentEnv: 'AVANTF_COMPAT_ABSENT',
      packageDirName: 'dsh-identity',
      prepare({ scratch, linkBase, fail }) {
        // The runtime externals an npm install would have put beside the package. Every `@avantf/*`
        // ENGINE name stays unlinked on purpose: this tree ships none, so a leaked engine import must
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
