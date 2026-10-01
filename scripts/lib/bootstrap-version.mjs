#!/usr/bin/env node
/**
 * Read — and move — the version a bootstrap file declares.
 *
 * One regex, one place: `link-envinit.mjs` copies the framework's `dist/bootstrap.js` and
 * `copy-envinit-bootstrap.mjs` / `build.mjs` assert the copy matches the linked framework, so all of
 * them need the same reader. A second copy of the pattern is how the assertion and the vendoring
 * drift apart. It used to live once per plugin repo; in the merged workspace there is one copy, under
 * `scripts/lib/`.
 *
 * WHY A WRITER TOO. The base's version exists TWICE: the publishable manifest, and the `VERSION`
 * constant baked into `src/bootstrap.ts`. The constant cannot be read from `package.json` at runtime
 * (this is the zero-dependency piece that runs before anything else is resolvable), so the two have to
 * move together — and until this module owned the writer, `pnpm version:set base` moved only the
 * manifest. The resulting drift was expensive to read: base's own two bootstrap assertions failed and
 * every plugin's vendoring stopped with "the base was built from a mismatched source tree", with
 * nothing naming the real cause. `version:set` now writes both; `version:check` asserts they agree.
 *
 * @module scripts/lib/bootstrap-version
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Groups whose version is BAKED into a source constant: group → repo-relative file. */
export const BAKED_CARRIERS = { base: 'base/plugin-base/src/bootstrap.ts' }

const VERSION_RE = /export const VERSION = '([^']*)'/u

/**
 * The `VERSION` constant baked into a bootstrap file.
 *
 * @param file - an absolute path to a bootstrap (`src/bootstrap.ts` or a built/vendored `bootstrap.js`).
 * @returns the version, or `undefined` when the file does not declare one.
 */
export function readBootstrapVersion(file) {
  return VERSION_RE.exec(readFileSync(file, 'utf8'))?.[1]
}

/**
 * Move a group's baked version constant, in place.
 *
 * @returns `{ file, was, version }` when the group has a baked carrier, `undefined` for the others
 *   (mem and mission record their version in the manifest alone).
 */
export function writeBakedVersion(root, group, version) {
  const file = BAKED_CARRIERS[group]
  if (file === undefined) return undefined
  const path = join(root, file)
  const before = readFileSync(path, 'utf8')
  const was = VERSION_RE.exec(before)?.[1]
  const after = before.replace(VERSION_RE, `export const VERSION = '${version}'`)
  if (after !== before) writeFileSync(path, after)
  return { file, was, version }
}

/**
 * Every way a group's baked constant disagrees with the version its manifest records.
 *
 * @param versions - group → the version the manifest records; a missing group is skipped (nothing to
 *   compare yet).
 * @returns human-readable problems, each naming the command that fixes it. Empty ⇒ consistent.
 */
export function bakedVersionProblems(root, versions) {
  const problems = []
  for (const [group, file] of Object.entries(BAKED_CARRIERS)) {
    const expected = versions[group]
    if (expected === undefined) continue
    const baked = readBootstrapVersion(join(root, file))
    if (baked === undefined) {
      problems.push(`${file} declares no \`export const VERSION = '...'\`; ${group} cannot be released from it`)
      continue
    }
    if (baked !== expected) {
      problems.push(
        `${group}: the manifest says ${expected} but ${file} bakes ${baked}`
        + ` — run \`pnpm version:set ${group} ${expected}\``,
      )
    }
  }
  return problems
}
