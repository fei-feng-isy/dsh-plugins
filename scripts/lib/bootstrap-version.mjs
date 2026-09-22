#!/usr/bin/env node
/**
 * Read the version a vendored bootstrap file declares.
 *
 * One regex, one place: `link-envinit.mjs` copies the framework's `dist/bootstrap.js` and
 * `copy-envinit-bootstrap.mjs` / `build.mjs` assert the copy matches the linked framework, so all of
 * them need the same reader. A second copy of the pattern is how the assertion and the vendoring
 * drift apart. It used to live once per plugin repo; in the merged workspace there is one copy, under
 * `scripts/lib/`.
 *
 * @module scripts/lib/bootstrap-version
 */
import { readFileSync } from 'node:fs'

/**
 * The `VERSION` constant baked into a bootstrap file.
 *
 * @param file - an absolute path to a `bootstrap.js`.
 * @returns the version, or `undefined` when the file does not declare one.
 */
export function readBootstrapVersion(file) {
  const match = /export const VERSION = '([^']*)'/u.exec(readFileSync(file, 'utf8'))
  return match?.[1]
}
