/**
 * One file write that a concurrent reader cannot catch half-done.
 *
 * The temp-then-rename pair is the whole point: a reader — the prompt assembly, or a preset read — sees
 * either the old text or the new one, never a torn file. It has ONE home because two writers need it:
 * the effective identity's `IdentityDocuments.write`, and the preset / profile-version writes in
 * `presets.ts`. A discipline with two implementations drifts (one gains an `fsync`, the other does not,
 * and nothing says which is correct).
 *
 * @module @avantf/dsh-identity/atomic-write
 */
import { renameSync, unlinkSync, writeFileSync } from 'node:fs'

/** Write `text` to `path` through a sibling temp file, then rename it into place. */
export function writeFileAtomically(path: string, text: string): void {
  const temporary = `${path}.tmp-${String(process.pid)}`
  try {
    writeFileSync(temporary, text, 'utf8')
    renameSync(temporary, path)
  } catch (error) {
    try {
      unlinkSync(temporary)
    } catch {
      // The temp file may not exist; the original failure is the one that matters.
    }
    throw error
  }
}
