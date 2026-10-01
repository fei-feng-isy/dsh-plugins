/**
 * The PURE hearts of the two root gates, so each assertion can be replayed on constructed input —
 * without a workspace, a registry or a build (`scripts/gates.test.mjs`).
 *
 * They live in `scripts/lib/` because that is the one place the boundary guard lets every tree share,
 * and because `scripts/release-check.mjs` / `scripts/check-dsh-lines.mjs` stay thin executables around
 * them: the executable does the I/O (read manifests, ask the registry, print), this module decides.
 */

/**
 * `link:` / `file:` / `workspace:` / `catalog:` (and a bare `*`) are LOCAL specifiers: fine in-source,
 * because pnpm rewrites them at pack time, but never what a plugin's REQUIRED peer on the base may be —
 * a host's package manager has to install the base from the registry.
 */
export function isLocalSpecifier(range) {
  return /^(?:link|file|workspace|catalog):/u.test(range) || range === '*'
}

/**
 * The base wiring a publishable plugin manifest must declare, on BOTH sides:
 *
 *   - `peerDependencies[@avantf/dsh-plugin-base]` — present, REQUIRED (the caller checks
 *     `peerDependenciesMeta`), and a publishable registry range; and
 *   - `devDependencies[@avantf/dsh-plugin-base]` — present, and the SAME range, so a plain
 *     `pnpm install` has something for `linkWorkspacePackages` to link without a second number that
 *     can drift from the one the published manifest asks a host for.
 *
 * `pnpm-workspace.yaml` says `scripts/release-check.mjs` "asserts both sides"; the peer half existed,
 * the dev half was never checked (review §2.2-2). Pure, so the pair can be exercised on constructed
 * manifests.
 *
 * Returns `{ problems, peer }`, where `peer` is the usable registry range (or `undefined`) for the
 * caller's further checks: does it accept the workspace base, and is it wide enough for a base-only
 * patch release?
 */
export function baseDependencyProblems(pluginName, manifest, base) {
  const problems = []
  const peer = manifest.peerDependencies?.[base]
  const peerUsable = typeof peer === 'string' && peer.trim() !== '' && !isLocalSpecifier(peer.trim())
  if (typeof peer !== 'string' || peer.trim() === '') {
    problems.push(`${pluginName} does not declare ${base} in peerDependencies — the host could not supply the base`)
  } else if (!peerUsable) {
    problems.push(`${pluginName}'s peer range for ${base} is ${peer} — it must be a publishable registry range`)
  }

  const dev = manifest.devDependencies?.[base]
  if (typeof dev !== 'string' || dev.trim() === '') {
    problems.push(`${pluginName} does not declare ${base} in devDependencies — a plain install would have nothing to link the base from`)
  } else if (isLocalSpecifier(dev.trim())) {
    problems.push(
      `${pluginName}'s devDependency on ${base} is ${dev} — it must stay a plain registry range, not a `
      + 'local specifier, so the packed manifest names something a host could resolve',
    )
  } else if (peerUsable && dev.trim() !== peer.trim()) {
    problems.push(
      `${pluginName} declares ${base} as peer "${peer.trim()}" but as devDependency "${dev.trim()}" — `
      + 'pnpm-workspace.yaml says both sides name the SAME range; a second, drifted number is how a local '
      + 'build stops exercising the range the published manifest asks a host for',
    )
  }
  return { problems, peer: peerUsable ? peer.trim() : undefined }
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
