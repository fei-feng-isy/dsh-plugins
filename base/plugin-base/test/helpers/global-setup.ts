/**
 * Build `dist/` once before the whole suite.
 *
 * Two specs import the built bootstrap/entry from a child process. With a per-spec rebuild they
 * could compile concurrently — one spec copying `dist/bootstrap.js` while the other rewrites it —
 * so the build lives here, in vitest's single global setup, instead.
 *
 * @module test/helpers/global-setup
 */
import { execFileSync } from 'node:child_process'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO_ROOT = dirname(dirname(dirname(fileURLToPath(import.meta.url))))

/** Newest mtime under `src/`, so a stale `dist/` is rebuilt. */
function newestSourceMtime(): number {
  let newest = 0
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) walk(path)
      else newest = Math.max(newest, statSync(path).mtimeMs)
    }
  }
  walk(join(REPO_ROOT, 'src'))
  return newest
}

export default function setup(): void {
  const entry = join(REPO_ROOT, 'dist', 'index.js')
  if (existsSync(entry) && statSync(entry).mtimeMs >= newestSourceMtime()) return
  execFileSync(process.execPath, [join(REPO_ROOT, 'node_modules', 'typescript', 'bin', 'tsc'), '-p', join(REPO_ROOT, 'tsconfig.json')], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
  })
}
