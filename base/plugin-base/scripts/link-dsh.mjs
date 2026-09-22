#!/usr/bin/env node
/**
 * Link this package's DSH peers from the INSTALLED dsh.
 *
 * TEST-TIME ONLY. The shipped code (`src/`) imports no `@deepseek-ai/*` package at all — that is what
 * keeps this base module independent of any dsh version — but its test suite mounts the host's REAL
 * registries to prove the probes work there. These symlinks are how those tests reach whatever dsh is
 * installed, with no version pinned anywhere in this repo.
 *
 * `--dsh <dir>` links a different install (any directory holding `node_modules/@deepseek-ai`);
 * without it, the global npm root's `@deepseek-ai/dsh` is used.
 */
import { execSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, symlinkSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Everything under `@deepseek-ai/` this repo imports: `dsh-tools` at runtime, the other two in tests. */
/** Imported by `test/` only: a context, the timer mixin, and the two real registries. */
const LINKS = ['cordis', 'cordis-plugin-timer', 'dsh-tools', 'dsh-typert-registry']

/** Where the symlinks live. */
const target = join(repo, 'node_modules', '@deepseek-ai')

/** The install to link from: `--dsh <dir>`, else the global `@deepseek-ai/dsh`. */
function resolveInstall() {
  const index = process.argv.indexOf('--dsh')
  const arg = index >= 0 ? process.argv[index + 1] : undefined
  if (arg !== undefined && !arg.startsWith('--')) {
    const dir = resolve(arg)
    return dir.endsWith('@deepseek-ai') ? dir : join(dir, 'node_modules', '@deepseek-ai')
  }
  let globalRoot
  try {
    globalRoot = execSync('npm root -g', { encoding: 'utf8' }).trim()
  } catch {
    console.error('link-dsh: cannot discover the global npm root; pass --dsh <dir>')
    process.exit(1)
  }
  return join(globalRoot, '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai')
}

const source = resolveInstall()
if (!existsSync(source)) {
  console.error(`link-dsh: installed dsh packages not found at ${source}`)
  console.error('  install one: npm i -g @deepseek-ai/dsh, or pass --dsh <dir>')
  process.exit(1)
}

mkdirSync(target, { recursive: true })

let linked = 0
for (const name of LINKS) {
  const from = join(source, name)
  const to = join(target, name)
  if (!existsSync(from)) {
    console.warn(`link-dsh: skip @deepseek-ai/${name} (not found at ${from})`)
    continue
  }
  // Remove THIS name only, so a stale link is replaced without wiping the directory.
  rmSync(to, { recursive: true, force: true })
  symlinkSync(from, to, 'dir')
  linked += 1
}
console.log(`link-dsh: ${String(linked)}/${String(LINKS.length)} package(s) ← ${source}`)
