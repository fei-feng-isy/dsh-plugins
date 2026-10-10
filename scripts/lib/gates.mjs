/**
 * The PURE hearts of the root gates, so each assertion can be replayed on constructed input —
 * without a workspace, a registry or a build (`scripts/gates.test.mjs`).
 *
 * They live in `scripts/lib/` because that is the one place the boundary guard lets every tree share,
 * and because `scripts/release-check.mjs` / `scripts/check-dsh-lines.mjs` stay thin executables around
 * them: the executable does the I/O (read manifests, ask the registry, print), this module decides.
 *
 * The published-base half of the release check — reading the interface generation out of a published
 * tarball and comparing it with a plugin's bake — lives in `scripts/lib/published-base.mjs`, for the
 * same reason.
 */

/**
 * `link:` / `file:` / `workspace:` / `catalog:` (and a bare `*`) are LOCAL specifiers: fine in-source,
 * because pnpm rewrites them at pack time, but never what a plugin's runtime DEPENDENCY on the base may
 * be — a host's package manager has to install the base from the registry.
 */
export function isLocalSpecifier(range) {
  return /^(?:link|file|workspace|catalog):/u.test(range) || range === '*'
}

/**
 * The base wiring a publishable plugin manifest must declare, on every side that matters.
 *
 * `@avantf/dsh-plugin-base` is a PLAIN RUNTIME DEPENDENCY of each plugin, because dsh writes
 * `autoInstallPeers: false` into every profile it manages (`dsh-app-boot/lib/index.js:566-567`), so the
 * "the host supplies the base" story a peer would tell is not true here: installing the plugin has to
 * pull the base in by itself. The old rule said the opposite (peer only, never `dependencies`) on the
 * theory that a runtime dependency forks the install; measured on the real packed artifacts, pnpm
 * (isolated), pnpm with `nodeLinker: hoisted` (what a dsh profile uses) and npm (flat) each install
 * exactly ONE physical copy — as long as the two plugins ask for the SAME range. A range that drifts
 * is the only way to grow a second copy, so that is the assertion, not a warning.
 *
 * The four assertions:
 *   1. the base is in `dependencies` — `peerDependencies` alone does not install it (see above);
 *   2. the range is a publishable registry range (never `workspace:`/`link:`/`file:`/`catalog:`/`*`);
 *   3. it is not optional — neither `optionalDependencies` nor `peerDependenciesMeta.optional`, so a
 *      host install cannot silently skip the one copy the plugin's bootstrap resolves;
 *   4. the range is WIDE (not `~`, not exact): one base release must be enough to fix shared code.
 *
 * The caller passes `previous` — the earlier plugin tree's `{ plugin, range }`, if any — and a
 * `range` that differs from it EVEN BY ONE CHARACTER is a problem (invariant: two plugins, one copy;
 * `scripts/release-check.mjs` walks the publish order, so mem is judged against mission and vice versa).
 * Keep the `devDependencies` entry at the same range too: it is what makes a plain `pnpm install`
 * resolve the workspace base (a published manifest must never carry a `workspace:` range). The dev
 * half is not asserted because the PUBLISHED range is the one a host install follows.
 *
 * Pure, so `scripts/gates.test.mjs` can replay each way the rule can be broken.
 *
 * @returns {{ problems: string[], range: string | undefined }} `range` is the usable registry range,
 *   or `undefined` when the wiring has no usable one.
 */
export function baseDependencyProblems(pluginName, manifest, base, previous) {
  const problems = []

  const raw = manifest.dependencies?.[base]
  const declared = typeof raw === 'string' && raw.trim() !== ''
  const usable = declared && !isLocalSpecifier(raw.trim())

  if (!declared) {
    const alsoAPeer = typeof manifest.peerDependencies?.[base] === 'string'
    const peerNote = alsoAPeer
      ? '; a peer alone does not — dsh writes "autoInstallPeers: false" into every profile, so nothing installs it'
      : ''
    problems.push(
      `${pluginName} does not declare ${base} in dependencies — installing the plugin must bring the base with it${peerNote}`,
    )
  } else if (!usable) {
    problems.push(
      `${pluginName}'s dependency on ${base} is ${raw} — it must be a publishable registry range: the `
      + 'packed manifest is what a host\'s package manager resolves, and it cannot resolve a local specifier',
    )
  }

  if (manifest.optionalDependencies?.[base] !== undefined) {
    problems.push(
      `${pluginName} lists ${base} in optionalDependencies — it is the plugin's one runtime dependency and `
      + 'must never be skippable: a missing base degrades the plugin at runtime, it does not uninstall it silently',
    )
  }
  if (manifest.peerDependenciesMeta?.[base]?.optional === true) {
    problems.push(
      `${pluginName} marks ${base} an OPTIONAL peer — nothing then requires the single copy the plugin's `
      + 'bootstrap resolves',
    )
  }

  if (usable && /^[~=]|^\d+\.\d+\.\d+$/u.test(raw.trim())) {
    problems.push(
      `${pluginName}'s range for ${base} is ${raw.trim()} — too narrow: a patch/minor base release (one base `
      + 'release must be enough to fix shared code) would fall outside it',
    )
  }

  // Invariant: two plugins, one base copy. Copies fork only when the ranges differ, so drift is fatal.
  if (previous !== undefined && typeof previous.range === 'string' && previous.range !== raw) {
    problems.push(
      `${pluginName} declares ${base} as ${String(raw)} but ${previous.plugin} declares ${previous.range} — `
      + 'the two plugins must name the SAME range, or the installer resolves them to two physical copies of '
      + 'the base and their registries/type identities fork',
    )
  }

  return { problems, range: usable ? raw.trim() : undefined }
}

/**
 * A dependency a publishable manifest must take from the HOST — present in `peerDependencies` and
 * REQUIRED (not optional), and absent from every section that would let the installer nest a copy.
 *
 * The one-zod rule (mem DESIGN §20.11) is why this exists: two copies, even of one major, have
 * incompatible type identities, so the plugin that uses zod at runtime must get the host's copy. A
 * peer that drifted into `dependencies`, or one that `peerDependenciesMeta` marks optional, reads as
 * "resolved locally" to the installer and forks the copy. `release-check` pinned the base's zod PEER
 * RANGE but never the plugin's zod LOCATION (N15), so moving `zod` in
 * `mem/packages/plugin/package.json` would not have turned the gate red.
 *
 * Pure, so `scripts/gates.test.mjs` can replay each way the rule can be broken.
 *
 * @param packageName - the manifest's `name`, for the message.
 * @param manifest - a publishable package manifest.
 * @param dependency - the package that must come from the host (e.g. `zod`).
 * @returns a list of problems, empty when the wiring is right.
 */
export function requiredPeerProblems(packageName, manifest, dependency) {
  const problems = []
  const peer = manifest.peerDependencies?.[dependency]
  if (typeof peer !== 'string' || peer.trim() === '') {
    problems.push(
      `${packageName} does not declare ${dependency} in peerDependencies — the HOST provides the single `
      + 'copy, so a local resolution would fork its type identity (e.g. zod schema identities)',
    )
  }
  if (manifest.peerDependenciesMeta?.[dependency]?.optional === true) {
    problems.push(
      `${packageName} marks ${dependency} an OPTIONAL peer — the host would not be required to provide it, `
      + 'and the installer would nest the plugin\'s own copy beside the host\'s',
    )
  }
  for (const section of ['dependencies', 'optionalDependencies']) {
    if (manifest[section]?.[dependency] !== undefined) {
      problems.push(
        `${packageName} lists ${dependency} in ${section} — it must be a PEER: a runtime dependency lets `
        + `the installer place a SECOND copy inside the plugin, and two copies (even of one major) do not `
        + 'share type identity',
      )
    }
  }
  return problems
}

/**
 * Judge every published dsh version against EACH declaring tree, rather than against their union.
 *
 * The dsh boot gate disables a plugin row whose OWN `peerDependencies` do not cover the running dsh.
 * So a line covered by `@avantf/dsh-mem` but not by `@avantf/dsh-mission` is already broken for
 * mission — but the union (`covered.length === 0`, the old check) made that permanently green: only a
 * line BOTH trees missed could ever fail (M8). Here a version is `missing` for every tree whose ranges
 * do not satisfy it, and there are two ways to fail:
 *
 *   - `missingLines` — a line at least ONE tree covers but another does not: pure drift, and the
 *     missing tree's row is disabled for everyone on that line. This is the shape the union hid, at
 *     any height (not just above the top), because the whole reason to compare the trees is that one
 *     of them may be narrower; and
 *   - `higherUncovered` — a line NO tree covers that sits above the highest line every tree covers:
 *     dsh has opened a new line nobody has declared yet.
 *
 * Lines NO tree covers that sit below the highest fully-covered line stay notes: the registry has old
 * 0.x lines nobody can claim, and flagging them would drown the signal.
 *
 * Pure: `versions`, `tags` and the `semver` implementation are inputs, so the judgement can be replayed
 * on a fixture. `semver` must provide `parse`, `gt`, `compare`, `eq` and `satisfies` (the installed
 * dsh's own copy is what the executable passes, so the judgement matches the boot gate's).
 *
 * @returns {{
 *   trees: string[],
 *   treeRanges: Record<string, string[]>,
 *   distinct: string[],
 *   declaredDivergence: boolean,
 *   lines: Array<{ line: string, newest: string, count: number, covered: string[], missing: string[] }>,
 *   tagRows: Array<{ tag: string, version: string, covered: string[], missing: string[] }>,
 *   uncoveredTags: Array<{ tag: string, version: string, covered: string[], missing: string[] }>,
 *   missingLines: Array<{ line: string, newest: string, count: number, covered: string[], missing: string[] }>,
 *   higherUncovered: Array<{ line: string, newest: string, count: number, covered: string[], missing: string[] }>,
 * }}
 */
export function judgeDshLines({ declared, versions, tags, semver }) {
  const trees = [...declared.keys()]
  const rangesOf = (tree) => declared.get(tree) ?? []
  const coveringTrees = (version) => trees.filter((tree) =>
    rangesOf(tree).some((range) => semver.satisfies(version, range, { includePrerelease: true })))
  const missingTrees = (version) => trees.filter((tree) => !coveringTrees(version).includes(tree))

  const byLine = new Map()
  for (const version of versions) {
    const parsed = semver.parse(version)
    if (parsed === null) continue
    const line = `${parsed.major}.${parsed.minor}`
    const current = byLine.get(line)
    if (current === undefined) byLine.set(line, { line, newest: version, count: 1 })
    else if (semver.gt(version, current.newest)) byLine.set(line, { line, newest: version, count: current.count + 1 })
    else byLine.set(line, { ...current, count: current.count + 1 })
  }
  const lines = [...byLine.values()]
    .map((entry) => ({ ...entry, covered: coveringTrees(entry.newest), missing: missingTrees(entry.newest) }))
    .sort((left, right) => semver.compare(`${left.line}.0`, `${right.line}.0`))

  // Drift: a line one tree covers and another does not (fail at any height).
  const missingLines = lines.filter((entry) => entry.covered.length > 0 && entry.missing.length > 0)
  // A new line NO tree covers, above the highest line every tree covers (fail: a fresh line nobody declared).
  const highestFullyCovered = lines.filter((entry) => entry.missing.length === 0).at(-1)
  const higherUncovered = lines.filter((entry) => entry.covered.length === 0
    && (highestFullyCovered === undefined || semver.gt(entry.newest, highestFullyCovered.newest)))

  const tagRows = Object.entries(tags).map(([tag, version]) => ({
    tag, version, covered: coveringTrees(version), missing: missingTrees(version),
  }))
  const uncoveredTags = tagRows.filter((row) => row.missing.length > 0)

  const treeRanges = Object.fromEntries(trees.map((tree) => [tree, rangesOf(tree)]))
  const distinct = [...new Set(trees.flatMap((tree) => rangesOf(tree)))]
  const declaredDivergence = new Set(trees.map((tree) => JSON.stringify([...rangesOf(tree)].sort()))).size > 1

  return { trees, treeRanges, distinct, declaredDivergence, lines, tagRows, uncoveredTags, missingLines, higherUncovered }
}
