/**
 * The three release versions, and the ONE manifest that records each of them.
 *
 * A version group is a top-level subtree (`base` | `mem` | `mission` | `identity`) and its version lives in
 * exactly one place: the manifest of that group's **publishable** package —
 *
 *   base     → base/plugin-base/package.json
 *   mem      → mem/packages/plugin/package.json
 *   mission  → mission/packages/plugin/package.json
 *   identity → identity/packages/plugin/package.json
 *
 * Everything else in the group (the subtree root manifest and the private engine packages) carries **no
 * `version` field at all**. They are never published — the plugins inline their engines and are linked by
 * path inside the workspace — so a second copy of the number would only be a second thing to update and
 * a second thing to drift. This was not always so: the group's version used to be repeated in every
 * manifest (nine for mem, three for the mission tree, then still called `work`) and kept in step by hand
 * or by a stamping command; the tests here are what stopped that (`pnpm version:check` fails if a private
 * manifest grows a `version` again).
 *
 * The one thing that still needs a version at pack time is a private target of the `workspace:` protocol:
 * `pnpm pack` rewrites `workspace:*` into the TARGET's version, so `withWorkspaceVersions()` materializes
 * that version around the pack call and restores the file byte for byte afterwards. Nothing is committed,
 * and `pnpm version:check` fails if a leftover survives a crash.
 *
 * `pnpm version:set <group> <version>` therefore edits ONE file, and there is nothing to propagate.
 * `scripts/version.mjs` (the CLI), `scripts/release-check.mjs` (the gate) and
 * `scripts/prepublish-assert.mjs` (the publish-time assertions) all read the mapping from here.
 */
import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** The version groups: one per top-level subtree, in the order the family publishes them. */
export const VERSION_GROUPS = ['base', 'mem', 'mission', 'identity']
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/u

/** Every tracked `package.json` of one group, relative to `root` (subtree root manifest included). */
export function groupManifests(root, group) {
  const out = execFileSync('git', ['ls-files', '-z', '--', group], {
    cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  })
  return out
    .split('\0')
    .filter((file) => file === `${group}/package.json` || (file.startsWith(`${group}/`) && file.endsWith('/package.json')))
    .sort()
}

/** `{ file, manifest }` for every tracked `package.json` of a group; unreadable ones are reported. */
function readGroupManifests(root, group) {
  const manifests = []
  const problems = []
  for (const file of groupManifests(root, group)) {
    try {
      manifests.push({ file, manifest: JSON.parse(readFileSync(join(root, file), 'utf8')) })
    } catch (error) {
      problems.push(`${file} is not readable JSON (${String(error?.message ?? error)})`)
    }
  }
  return { manifests, problems }
}

/**
 * The manifest that records a group's version: its ONE publishable package, found by the `private` flag
 * rather than by a hardcoded path (the same "exactly one publishable package per tree" invariant the
 * root release gate asserts).
 */
export function publishableManifest(root, group) {
  const { manifests, problems } = readGroupManifests(root, group)
  if (problems.length > 0) return { file: undefined, problems }
  const publishable = manifests.filter((entry) => entry.manifest.private !== true)
  if (publishable.length === 0) problems.push(`group ${group} has no publishable package (every manifest is private)`)
  if (publishable.length > 1) {
    problems.push(`group ${group} has ${String(publishable.length)} publishable packages (${publishable.map((entry) => entry.file).join(', ')}) — the group version needs exactly one carrier`)
  }
  return { file: publishable[0]?.file, problems }
}

/**
 * The whole picture: `{ versions, carriers, problems }`.
 *
 * `versions[group]` is what that group's publishable manifest records (also validated as semver), and
 * `carriers[group]` is the file it was read from. Every problem is collected rather than thrown so a gate
 * can print all of them: a missing/invalid version, no single publishable carrier, or — the one this
 * design exists to prevent — a private manifest that restates the version.
 */
export function versionState(root) {
  const versions = {}
  const carriers = {}
  const problems = []
  for (const group of VERSION_GROUPS) {
    const carrier = publishableManifest(root, group)
    problems.push(...carrier.problems)
    if (carrier.file === undefined) continue
    carriers[group] = carrier.file
    const { manifests, problems: readProblems } = readGroupManifests(root, group)
    problems.push(...readProblems)
    const publishable = manifests.find((entry) => entry.file === carrier.file)?.manifest
    const version = publishable?.version
    if (typeof version !== 'string' || !SEMVER.test(version)) {
      problems.push(`${carrier.file} must carry the group's version as semver (found ${JSON.stringify(version)})`)
    } else {
      versions[group] = version
    }
    for (const { file, manifest } of manifests) {
      if (file === carrier.file) continue
      if (manifest.version === undefined) continue
      problems.push(`${file} carries version ${JSON.stringify(manifest.version)} but is private — the group's version is recorded ONLY in ${carrier.file}; run \`pnpm version:prune\``)
    }
  }
  return { versions, carriers, problems }
}

/** The manifest sections `pnpm pack` can rewrite a `workspace:` specifier in. */
const WORKSPACE_SECTIONS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']

/** Which version group a workspace-relative manifest path belongs to (`undefined` for root tooling). */
export function groupOfFile(file) {
  return VERSION_GROUPS.find((group) => file === `${group}/package.json` || file.startsWith(`${group}/`))
}

/**
 * The private workspace packages ONE group's publishable manifest refers to with the `workspace:`
 * protocol.
 *
 * They are the ONE thing that still needs a version at pack time: `pnpm pack` rewrites every
 * `workspace:*` specifier into the target's version, and a target with no `version` makes the pack fail
 * with `ERR_PNPM_CANNOT_RESOLVE_WORKSPACE_PROTOCOL`. They are also not published, so the version is
 * MATERIALIZED for the duration of the pack and removed again — it is never committed, and
 * `version:check` fails if one is left behind.
 *
 * SCOPED TO THE GROUP on purpose (M7): a pack rewrites the manifest it is packing, which belongs to
 * exactly one group. Materializing the version on ANOTHER group's private package is visible to every
 * concurrent gate and test for the duration of the pack, and a killed pack leaves the number behind
 * where the release projection's `git add -A` can commit it. The targets are resolved inside the group
 * too: a `workspace:` specifier pointing at another tree (the boundary guard forbids it) is reported,
 * never written.
 */
export function groupWorkspaceTargets(root, group) {
  const problems = []
  const carrier = publishableManifest(root, group)
  problems.push(...carrier.problems)
  if (carrier.file === undefined) return { targets: [], problems }
  const manifest = JSON.parse(readFileSync(join(root, carrier.file), 'utf8'))
  const wanted = new Set()
  for (const section of WORKSPACE_SECTIONS) {
    for (const [name, specifier] of Object.entries(manifest[section] ?? {})) {
      if (typeof specifier === 'string' && specifier.startsWith('workspace:')) wanted.add(name)
    }
  }
  if (wanted.size === 0) return { targets: [], problems }
  const byName = new Map()
  for (const file of groupManifests(root, group)) {
    const candidate = JSON.parse(readFileSync(join(root, file), 'utf8'))
    if (typeof candidate.name === 'string') byName.set(candidate.name, { file, manifest: candidate })
  }
  const targets = []
  for (const name of [...wanted].sort()) {
    const found = byName.get(name)
    if (found === undefined) {
      problems.push(`${carrier.file} depends on ${name} through the workspace protocol, but no manifest in group ${group} declares it`)
      continue
    }
    if (found.manifest.private !== true) {
      // A publishable target carries its own version already (its group's), so nothing to materialize.
      continue
    }
    targets.push({ name, file: found.file })
  }
  return { targets, problems }
}

/**
 * Every private workspace-protocol target across ALL groups. Kept for reporting and for the
 * cross-group guard in {@link withWorkspaceVersions}; it is deliberately NOT the default there any
 * more, because a pack must materialize only its own group's targets (M7).
 */
export function workspaceTargets(root) {
  const problems = []
  const byFile = new Map()
  for (const group of VERSION_GROUPS) {
    const found = groupWorkspaceTargets(root, group)
    problems.push(...found.problems)
    for (const target of found.targets) byFile.set(target.file, target)
  }
  return { targets: [...byFile.values()].sort((left, right) => left.file.localeCompare(right.file)), problems }
}

/** Accept the `{ targets }` result shape (and a bare array) for the explicit-targets caller. */
function explicitTargets(value) {
  if (Array.isArray(value)) return value
  if (value !== null && typeof value === 'object' && Array.isArray(value.targets)) {
    if (Array.isArray(value.problems) && value.problems.length > 0) {
      throw new Error(`withWorkspaceVersions: cannot materialize a version:\n  ${value.problems.join('\n  ')}`)
    }
    return value.targets
  }
  throw new TypeError('withWorkspaceVersions: `targets` must be an array of { file } entries (or a { targets } result)')
}

/**
 * Run `run()` with `version` materialized on the private workspace-protocol targets, then restore the
 * files byte for byte. Used by the pack scripts around `pnpm pack`; the restore runs in a `finally`, so a
 * failed pack does not leave a version behind (only a SIGKILL can, and `version:check`/`version:prune`
 * clean that up).
 *
 * The caller must say which group it packs, either as `{ group }` (narrowed to that group's targets) or
 * as an explicit `{ targets }`. Calling it with NEITHER is allowed only while every target in the
 * workspace belongs to ONE group; when the targets span groups it throws instead of silently rewriting
 * a sibling tree's manifests — that silent cross-group write is the M7 defect, and guessing the caller's
 * group is exactly how it recurs. The two pack scripts in `mem/scripts` and `mission/scripts` therefore
 * pass `{ group: 'mem' }` / `{ group: 'mission' }`.
 */
export function withWorkspaceVersions(root, version, run, options = {}) {
  const { targets, group } = options
  let resolved
  if (targets !== undefined) {
    resolved = explicitTargets(targets)
  } else if (group !== undefined) {
    if (!VERSION_GROUPS.includes(group)) {
      throw new Error(`withWorkspaceVersions: unknown group ${JSON.stringify(group)} (expected one of ${VERSION_GROUPS.join(', ')})`)
    }
    const found = groupWorkspaceTargets(root, group)
    if (found.problems.length > 0) {
      throw new Error(`withWorkspaceVersions: cannot materialize ${group}'s version:\n  ${found.problems.join('\n  ')}`)
    }
    resolved = found.targets
  } else {
    const found = workspaceTargets(root)
    if (found.problems.length > 0) {
      throw new Error(`withWorkspaceVersions: cannot materialize a version:\n  ${found.problems.join('\n  ')}`)
    }
    const groups = [...new Set(found.targets.map((target) => groupOfFile(target.file)).filter((value) => value !== undefined))]
    if (groups.length > 1) {
      throw new Error(
        'withWorkspaceVersions: no { group } given, but the workspace-protocol targets span '
        + `${groups.length} groups (${groups.join(', ')}) — materializing one group's version on another `
        + "group's manifests is the M7 defect (a concurrent gate or test reads the wrong version for the "
        + 'duration of the pack, and a killed pack leaves the number behind). Say which group you pack:\n'
        + "  withWorkspaceVersions(workspace, manifest.version, run, { group: 'mem' })",
      )
    }
    resolved = found.targets
  }
  const saved = resolved.map((target) => ({ ...target, text: readFileSync(join(root, target.file), 'utf8') }))
  try {
    for (const target of saved) {
      const manifest = JSON.parse(target.text)
      manifest.version = version
      writeFileSync(join(root, target.file), `${JSON.stringify(manifest, null, 2)}\n`)
    }
    return run()
  } finally {
    for (const target of saved) writeFileSync(join(root, target.file), target.text)
  }
}
