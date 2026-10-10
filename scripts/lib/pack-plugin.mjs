#!/usr/bin/env node
/**
 * The assertions `pack-plugin` runs on a plugin's tarball — ONE implementation for both trees, with
 * the union of what each tree used to check.
 *
 * WHY THIS EXISTS. Two trees each wrote their own packer, and the two assertion sets were
 * non-overlapping: mem asserted the tarball carried no strays, that the bundles are self-contained,
 * and that no `workspace:` specifier survived; mission asserted every shipped file's peers are
 * declared, that the bake and `VERSION_PACKAGES` agree BOTH ways, and that the shipped declaration
 * tree's relative imports close. Each tree therefore shipped a hole the other had already closed.
 * The fix is structural: the assertions live here (in `scripts/lib/`, the one place the boundary
 * guard lets every tree reach), and each tree's `scripts/pack-plugin.mjs` is a thin entry that binds
 * this module to its own package names, bootstrap shape and carried-types directory.
 *
 * The union is real, not nominal: BOTH trees now run BOTH sets. Where a check is a property of the
 * tree's shape (mem inlines the base bootstrap into the entry, mission ships it as a copied file and
 * imports it relatively; mem carries engine declarations into `lib/engine/`, mission into
 * `lib/mission-core/`) the SHAPE is configuration and the CHECK is shared.
 *
 * `pnpm pack` is required rather than `npm pack`: it rewrites `catalog:` / `workspace:` into real
 * ranges, and the tarball's manifest is one of the things asserted.
 *
 * TWO THINGS HERE ARE NOT ASSERTIONS. `shippedDeclarationNote` prints how many shipped exported
 * symbols nothing in the repo ever consumes — an OBSERVATION about how fast the surface sediments.
 * `documentationCountNote` prints the counts a PUBLISHED README (or AGENTS.md) states that no longer
 * match the code producing them. Neither is a gate: each proves no single property and can never fail
 * a run (a gate must prove one thing). Everything else in this module is an assertion and does fail.
 *
 * **改可观察行为必须同步 README/DESIGN.** The shipped README IS the npm page and AGENTS.md is what the
 * next contributor reads, so a number that drifted from the code (a tool added, a command retired, a
 * prompt section merged) is a DEFECT, not cosmetics — see AGENTS.md「发布 README 的内容要求」.
 *
 * @module scripts/lib/pack-plugin
 */
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, posix, resolve } from 'node:path'

import { readBootstrapVersion } from './bootstrap-version.mjs'

/** The family base: the one `@avantf/*` package a runtime section may name, as a PLAIN dependency. */
export const FRAMEWORK_PEER = '@avantf/dsh-plugin-base'

/**
 * A unique string in the base kit's `PromptFiles` writer (`base/plugin-base/src/kit/prompt_files.ts`).
 *
 * The kit is consumed at RUNTIME off the base module so that fixing a shared helper takes ONE base
 * release — no plugin rebuild. Inlining it back into a bundle would silently break that promise and
 * nothing else in the artifact would show it, so its presence is a build error on both halves.
 */
export const KIT_MARKER = 'prompt file was blank and has been filled'

/**
 * Parse `pack-plugin`'s flags. `--out` takes a value; a missing one is an error, not a silent default.
 * `--keep` is only meaningful together with `--mount` (there is no scratch profile otherwise), so it
 * is rejected alone rather than accepted as a no-op. An UNKNOWN flag exits non-zero: `--mount` used to
 * be accepted and silently ignored, so a release run looked like the tarball had been mounted.
 * @returns `{ mount, keep, outDir }`.
 */
export function parsePackArgs(argv, { defaultOutDir }) {
  let mount = false
  let keep = false
  let outArg
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--mount') { mount = true; continue }
    if (arg === '--keep') { keep = true; continue }
    if (arg === '--out') {
      outArg = argv[index + 1]
      if (outArg === undefined || outArg.startsWith('--')) {
        console.error('pack-plugin: --out needs a directory')
        process.exit(2)
      }
      index += 1
      continue
    }
    console.error(`pack-plugin: unknown option ${arg}`)
    console.error('  usage: node scripts/pack-plugin.mjs [--mount] [--keep] [--out <dir>]')
    console.error('  an unsupported option is NOT ignored — that is how `--mount` looked verified without mounting anything')
    process.exit(2)
  }
  if (keep && !mount) {
    console.error('pack-plugin: --keep only applies to --mount (without it there is no scratch profile to keep)')
    process.exit(2)
  }
  const outDir = outArg === undefined ? defaultOutDir : resolve(outArg)
  if (outDir === resolve('/')) {
    console.error('pack-plugin: refusing to pack into /')
    process.exit(2)
  }
  return { mount, keep, outDir }
}

/** Remove only tarballs from a pack destination (it may hold a tracked source file). */
export function clearTarballs(outDir) {
  mkdirSync(outDir, { recursive: true })
  for (const entry of readdirSync(outDir)) {
    if (entry.endsWith('.tgz')) rmSync(join(outDir, entry))
  }
}

/** Package name of a bare specifier (`@scope/name/sub` → `@scope/name`). */
export function packageName(specifier) {
  const parts = specifier.split('/')
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]
}

/** Every bare specifier a bundle reaches at runtime: static imports, re-exports, dynamic imports, requires. */
export function specifiersIn(code) {
  const found = new Set()
  for (const pattern of [
    /^\s*import\s[^;]*?from\s*["']([^"']+)["']/gm,
    /^\s*export\s[^;]*?from\s*["']([^"']+)["']/gm,
    /import\(\s*["']([^"']+)["']\s*\)/g,
    /require\(\s*["']([^"']+)["']\s*\)/g,
  ]) {
    for (const match of code.matchAll(pattern)) found.add(match[1])
  }
  return [...found].sort()
}

/** Remove line and block comments while leaving string literals alone. */
export function stripComments(source) {
  let out = ''
  let quote = null
  for (let i = 0; i < source.length; i += 1) {
    const ch = source[i]
    const next = source[i + 1]
    if (quote !== null) {
      out += ch
      if (ch === '\\') { out += next ?? ''; i += 1; continue }
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; out += ch; continue }
    if (ch === '/' && next === '/') { while (i < source.length && source[i] !== '\n') i += 1; out += '\n'; continue }
    if (ch === '/' && next === '*') {
      i += 2
      while (i < source.length && !(source[i] === '*' && source[i + 1] === '/')) i += 1
      i += 1
      continue
    }
    out += ch
  }
  return out
}

/**
 * The package names a `VERSION_PACKAGES` array body declares.
 *
 * Comments are stripped FIRST, and that is the whole point of this function: the body is prose-heavy
 * (each entry may carry a note explaining why it is or is not listed), and an apostrophe in that prose
 * — "part of this plugin's compile surface" — pairs with the next quote anywhere below and swallows
 * every real entry in between. Measured 2026-10-02: mission's list was read as 8 junk fragments plus
 * 8 missing packages, and the gate reported ten problems against a list that was in fact complete.
 * @param arrayBody - the text between `[` and `]` of the declaration.
 * @returns the declared specifiers, in source order.
 */
export function versionPackageNames(arrayBody) {
  return [...stripComments(arrayBody).matchAll(/'([^']+)'/gu)].map((match) => match[1])
}

/**
 * The entries of a `const NAME … = [ … ]` array literal, split at TOP-LEVEL commas only.
 *
 * `stripComments` runs first — the bodies are prose-heavy, and an apostrophe in a comment would pair
 * with the next quote and swallow the list (the defect {@link versionPackageNames} documents). The
 * scan then tracks bracket depth and string state, so an entry that is itself an object carrying a
 * comma (`{ file: 'a.md', section: X }`) stays ONE entry instead of being counted as two.
 *
 * @param source - the module's text.
 * @param name - the identifier the array is bound to.
 * @returns the trimmed entries, or `undefined` when the declaration is not there to count.
 */
export function arrayEntries(source, name) {
  const code = stripComments(source)
  const body = new RegExp(`\\b${name}\\b[^=]*=\\s*\\[([\\s\\S]*?)\\]`, 'u').exec(code)?.[1]
  if (body === undefined) return undefined
  const entries = []
  let current = ''
  let depth = 0
  let quote = null
  for (let index = 0; index < body.length; index += 1) {
    const ch = body[index]
    if (quote !== null) {
      current += ch
      if (ch === '\\') { current += body[index + 1] ?? ''; index += 1; continue }
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; current += ch; continue }
    if (ch === '(' || ch === '[' || ch === '{') { depth += 1; current += ch; continue }
    if (ch === ')' || ch === ']' || ch === '}') { depth -= 1; current += ch; continue }
    if (ch === ',' && depth === 0) { if (current.trim() !== '') entries.push(current.trim()); current = ''; continue }
    current += ch
  }
  if (current.trim() !== '') entries.push(current.trim())
  return entries
}

/**
 * The names a declaration surface introduces: `export declare const/function/class/interface/type/…`
 * and export lists (`export { a, b as c }`, `export type { … }`), where the name a consumer imports is
 * the one after `as`. `export * from '…'` names no symbol and `export default` has no stable name to
 * search the repo for, so neither contributes.
 *
 * This is the pure half of the dead-export OBSERVATION (`unconsumedExports`); it takes text, so a
 * shipped artifact can be judged without a filesystem.
 */
export function exportedSymbolNames(declarationText) {
  const names = new Set()
  const declared = /^export\s+(?:declare\s+)?(?:abstract\s+)?(?:const|let|var|function|class|interface|type|enum|namespace)\s+([A-Za-z_$][\w$]*)/gmu
  for (const match of declarationText.matchAll(declared)) names.add(match[1])
  for (const match of declarationText.matchAll(/^export\s+(?:type\s+)?\{([^}]*)\}/gmu)) {
    for (const name of exportListNames(match[1])) names.add(name)
  }
  return [...names]
}

/** The names an `export { … }` body publishes: the alias when the entry renames, the entry otherwise. */
function exportListNames(body) {
  const names = []
  for (const part of body.split(',')) {
    const entry = part.trim().replace(/^type\s+/u, '')
    if (entry === '') continue
    const renamed = /\bas\s+([A-Za-z_$][\w$]*)$/u.exec(entry)
    const name = renamed === null ? entry : renamed[1]
    if (/^[A-Za-z_$][\w$]*$/u.test(name)) names.push(name)
  }
  return names
}

/**
 * Whole-identifier occurrences of every name across a corpus of source texts.
 *
 * Comments and string literals count: this is a text-level approximation, and counting them only ever
 * makes a symbol look MORE consumed (a false negative), never less. That is the safe direction for an
 * observation — it under-reports rather than pointing at live code.
 */
export function identifierCounts(sourceTexts) {
  const counts = new Map()
  for (const text of sourceTexts) {
    for (const match of text.matchAll(/[A-Za-z_$][\w$]*/gu)) {
      counts.set(match[0], (counts.get(match[0]) ?? 0) + 1)
    }
  }
  return counts
}

/**
 * Exported symbols declared in `declarationText` that nothing in the repo consumes.
 *
 * A name is UNCONSUMED when the source corpus mentions it at most once as a whole identifier: that
 * single mention is the declaration itself. A symbol used even inside its own module is mentioned at
 * least twice and therefore counts as alive — which is the distinction that matters, because a symbol
 * alive but `export`ed redundantly is a style question, while one nothing references is removable.
 *
 * This is deliberately an OBSERVATION, not a gate: the caller only prints the count. It never fails a
 * pack, and an empty corpus (or a surface that declares nothing) simply yields zero.
 *
 * @param declarationText - the shipped declaration surface, concatenated.
 * @param sourceTexts - the consumer corpus, one text per repo source file.
 * @param options.exclude - names never judged: deliberate mirrors and the base's frozen interface
 *   members. They have no in-repo consumer by construction, so counting them would be noise.
 * @returns `{ exported, unconsumed, unconsumedNames }`; `exported` is the whole scanned surface,
 *   `unconsumed` the judged subset with no consumer.
 */
export function unconsumedExports(declarationText, sourceTexts, { exclude = [] } = {}) {
  const skip = new Set(exclude)
  const names = exportedSymbolNames(declarationText)
  const counts = identifierCounts(sourceTexts)
  const unconsumedNames = names.filter((name) => !skip.has(name) && (counts.get(name) ?? 0) <= 1)
  return { exported: names.length, unconsumed: unconsumedNames.length, unconsumedNames }
}

/**
 * Every module specifier a source imports or requires, in all forms; comments are stripped first so
 * documentation examples cannot trip a `from`-only pattern.
 */
export function importSpecifiers(source) {
  const code = stripComments(source)
  const patterns = [
    /\bfrom\s+['"]([^'"]+)['"]/gu,
    /\bimport\s+['"]([^'"]+)['"]/gu,
    /\bimport\s*\(\s*['"]([^'"]+)['"]/gu,
    /\brequire\s*\(\s*['"]([^'"]+)['"]/gu,
  ]
  const found = new Set()
  for (const pattern of patterns) for (const match of code.matchAll(pattern)) found.add(match[1])
  return [...found]
}

/**
 * The bare specifiers `source` reaches through a STATIC value import only.
 *
 * Dynamic `import('…')` is deliberately excluded: it is exactly how the base is meant to be reached —
 * through the inlined bootstrap — and it is the only form that still works when the peer is missing. A
 * STATIC value import would throw while the module was being evaluated, before the bootstrap could run.
 */
export function staticImportSpecifiers(source) {
  const found = new Set()
  for (const line of stripComments(source).split('\n')) {
    const statement = /^\s*import\s+(?!\()(.+)$/u.exec(line)
    if (statement === null) continue
    const rest = statement[1].trim()
    const from = /\bfrom\s*['"]([^'"]+)['"]/u.exec(rest)
    if (from !== null) {
      found.add(from[1])
      continue
    }
    const bare = /^['"]([^'"]+)['"]/u.exec(rest)
    if (bare !== null) found.add(bare[1])
  }
  return [...found]
}

/** Whether a shipped path (relative to the package root, POSIX) is the BROWSER half. */
export function isBrowserHalf(rel) {
  return rel === 'lib/client.js' || rel.startsWith('lib/types/client/')
}

/** The relative path of a tarball entry inside the package (`package/lib/x` → `lib/x`). */
export function insidePackage(entry) {
  return entry.replace(/^package\//u, '')
}

/** Every file the tarball carries. */
export function readTarEntries(tarball) {
  const result = spawnSync('tar', ['-tzf', tarball], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (result.status !== 0) throw new Error(`cannot list ${tarball}`)
  return (result.stdout ?? '').split('\n').filter((entry) => entry !== '')
}

/** The bytes of one tarball entry. */
export function readTarFile(tarball, entry) {
  const result = spawnSync('tar', ['-xzOf', tarball, entry], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (result.status !== 0) throw new Error(`cannot read ${entry} from ${tarball}`)
  return result.stdout
}

/** Resolve `name` upward to the nearest `package.json` — several DSH packages do not export `./package.json`. */
export function linkedVersion(require, name) {
  try {
    let dir = dirname(require.resolve(name))
    for (;;) {
      const manifest = join(dir, 'package.json')
      if (existsSync(manifest)) {
        const version = JSON.parse(readFileSync(manifest, 'utf8')).version
        return typeof version === 'string' && version !== '' ? version : 'NO-VERSION'
      }
      const up = dirname(dir)
      if (up === dir) return 'NO-PACKAGE-JSON'
      dir = up
    }
  } catch (error) {
    return `UNRESOLVED(${String(error?.code ?? error?.name ?? error)})`
  }
}

/**
 * One shipped file must only reach specifiers a user's install can answer for.
 *
 * Two callers pass different shape expectations: the BUNDLES (relative specifiers are an error — the
 * artifact must be a single file for mem — and the framework peer may not appear at all) and shipped
 * DECLARATION files (relative specifiers are expected and the closure check resolves them; the
 * framework peer is a legitimate type import). A declaration may type-import ANY harness module: the
 * host provides the whole `@deepseek-ai/*` tree, and a type-only edge is erased from the bundle but
 * kept in the `.d.ts`.
 */
export function assertSelfContained(fail, label, code, declared, { client, allowFramework = false, allowRelative = false, types = false }) {
  for (const specifier of specifiersIn(code)) {
    const name = packageName(specifier)
    if (specifier.startsWith('.') || specifier.startsWith('/')) {
      if (!allowRelative) fail(`${label}: relative specifier "${specifier}" — the artifact must be a single file`)
      continue
    }
    if (specifier.startsWith('@avantf/')) {
      if (allowFramework && name === FRAMEWORK_PEER) continue
      fail(types
        ? `${label}: names "${specifier}" — a shipped declaration may only reference the ${FRAMEWORK_PEER} peer; carry the engine's declarations and repoint them`
        : `${label}: imports "${specifier}" — the engine is not inlined (keep @avantf/* in devDependencies)`)
      continue
    }
    if (specifier.startsWith('node:') || declared.has(name)) continue
    // The browser half may only reach the loader module table: @deepseek-ai rows and the react family.
    if (client && (name === 'react' || name === 'react-dom' || name.startsWith('@deepseek-ai/'))) continue
    if (types && name.startsWith('@deepseek-ai/')) continue
    fail(`${label}: imports "${specifier}" but no dependency/peer declares it`)
  }
}

/**
 * Every declared production dependency must actually be reached, or the user installs dead weight.
 *
 * The base is the deliberate exception: it IS a production dependency (installing the plugin must
 * install the base), but no shipped file names it as a specifier — the inlined bootstrap resolves it
 * at RUNTIME with `createRequire(...).resolve(...)`, which is exactly the "no static import" rule.
 */
export function assertNoDeadDependencies(fail, label, code, declared) {
  const reached = new Set(specifiersIn(code).map(packageName))
  for (const name of declared) {
    if (name === FRAMEWORK_PEER) continue
    if (!reached.has(name)) fail(`${label}: "${name}" is declared but never imported — drop it from the production sections`)
  }
}

/**
 * The read-only inputs every check below needs, derived once from a tree's config.
 */
function contextOf(config) {
  const manifest = JSON.parse(readFileSync(join(config.pluginDir, 'package.json'), 'utf8'))
  const production = { ...manifest.dependencies, ...manifest.optionalDependencies }
  const declaredNames = new Set([...Object.keys(production), ...Object.keys(manifest.peerDependencies ?? {})])
  return { manifest, production, declaredNames }
}

/**
 * The checkout-side assertions: manifest shape, the bundles, the framework wiring, the bake record and
 * the baked interface record. Runs before `pnpm pack`, on the build directory the tarball is made from.
 *
 * @param config.pluginDir - `<tree>/packages/plugin`.
 * @param config.bootstrap - `'inlined'` (mem: the entry carries the bootstrap text) or `'copied'`
 *   (mission: `lib/envinit-bootstrap.js` ships beside the entry and the entry imports it relatively).
 * @param config.versionPackagesFile - the source file declaring `VERSION_PACKAGES`.
 * @param config.allowBakedSuperset - `true` when the tree deliberately bakes every linked dsh package
 *   while its gate compares a named subset (mem). The reverse direction (every package the gate names
 *   is baked) is enforced for both trees either way.
 *
 *   **这处不对称是接受的（用户 2026-10-02 决定，落档在此，免去后来者考古）**：mem 故意 bake 整个 linked 集合
 *   （这样该文件不会与实际链接到的版本漂移），而它的门禁只比对 `provision.ts` 里的两个名字；正向断言会要求
 *   改 `provision.ts`，超出那次收敛的范围。反向断言——门禁点到的每个包都必须被 bake——对两棵树一律强制，
 *   而那个方向才是"静默回落到 peer 区间下限"的风险所在。mission 不需要豁免（它的 `VERSION_PACKAGES` 已列全，
 *   两个方向本来就一致）。
 * @returns `{ problems, notes }`.
 */
export function assertCheckout(config) {
  const problems = []
  const fail = (message) => problems.push(message)
  const { pluginDir } = config
  const { manifest, production, declaredNames } = contextOf(config)

  // ── the manifest ─────────────────────────────────────────────────────────────────────────────
  // The base is the plugin's one RUNTIME dependency: dsh writes `autoInstallPeers: false` into every
  // profile, so a peer would not be installed and "install the plugin → get the base" would be false.
  // The one-copy invariant is not "a peer, never a runtime dep" — measured on the real artifacts, pnpm
  // isolated / pnpm hoisted / npm flat all install exactly one copy as long as both plugins name the
  // SAME range, so that sameness is what this asserts (see the sibling check below).
  const baseRange = manifest.dependencies?.[FRAMEWORK_PEER]
  if (typeof baseRange !== 'string' || baseRange.trim() === '') {
    fail(`manifest: "${FRAMEWORK_PEER}" is not a runtime dependency — installing the plugin must bring the base with it (a peer does not: dsh sets autoInstallPeers: false)`)
  } else if (/^(?:link|file|workspace|catalog):/u.test(baseRange.trim()) || baseRange.trim() === '*') {
    fail(`manifest: "${FRAMEWORK_PEER}" is declared as "${baseRange}" — the packed manifest must carry a registry range a host's installer can resolve`)
  }
  if (manifest.optionalDependencies?.[FRAMEWORK_PEER] !== undefined) {
    fail(`manifest: "${FRAMEWORK_PEER}" is in optionalDependencies — it is the plugin's one runtime dependency and must never be skippable`)
  }
  if (manifest.peerDependenciesMeta?.[FRAMEWORK_PEER]?.optional === true) {
    fail(`manifest: "${FRAMEWORK_PEER}" is marked an optional peer — the base is installed as a dependency, not negotiated with the host`)
  }
  // `devDependencies` is what makes `pnpm install` link the workspace base; it must name the SAME
  // range as `dependencies` so a local build never runs against a number the published manifest does
  // not ask for. (The published `dependencies` range is the one a host install follows.)
  if (typeof manifest.devDependencies?.[FRAMEWORK_PEER] === 'string'
    && typeof baseRange === 'string' && manifest.devDependencies[FRAMEWORK_PEER] !== baseRange) {
    fail(`manifest: "${FRAMEWORK_PEER}" is "${baseRange}" in dependencies but "${manifest.devDependencies[FRAMEWORK_PEER]}" in devDependencies — both must name the SAME range`)
  }
  // Two plugins, one base copy: the two trees must ask for the IDENTICAL range. Read from the sibling
  // tree rather than a constant here, so the number still lives in exactly one place (the manifests).
  const siblingName = manifest.name === '@avantf/dsh-mem' ? '@avantf/dsh-mission' : '@avantf/dsh-mem'
  const siblingDir = manifest.name === '@avantf/dsh-mem' ? 'mission/packages/plugin' : 'mem/packages/plugin'
  const siblingManifest = join(dirname(dirname(dirname(pluginDir))), siblingDir, 'package.json')
  if (existsSync(siblingManifest)) {
    const siblingRange = JSON.parse(readFileSync(siblingManifest, 'utf8')).dependencies?.[FRAMEWORK_PEER]
    if (typeof baseRange === 'string' && siblingRange !== baseRange) {
      fail(`manifest: this tree declares "${FRAMEWORK_PEER}": "${baseRange}" but ${siblingName} declares "${String(siblingRange)}" — the two plugins must name the SAME range, or the installer resolves them to two physical copies of the base`)
    }
  }
  for (const section of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    for (const name of Object.keys(manifest[section] ?? {})) {
      if (name.startsWith('@avantf/') && name !== FRAMEWORK_PEER) {
        fail(`manifest: "${name}" is in ${section} — the engine must stay a devDependency`)
      }
    }
  }

  const entry = join(pluginDir, config.entry)
  const clientEntry = join(pluginDir, config.clientEntry)
  for (const rel of [config.entry, config.clientEntry]) {
    if (!existsSync(join(pluginDir, rel))) {
      console.error(`pack-plugin: ${rel} is missing — run \`pnpm build:dsh\` first`)
      process.exit(1)
    }
  }
  const nodeCode = readFileSync(entry, 'utf8')
  const clientCode = readFileSync(clientEntry, 'utf8')

  assertSelfContained(fail, config.entry, nodeCode, declaredNames, {
    client: false,
    allowRelative: config.bootstrap === 'copied',
  })
  assertSelfContained(fail, config.clientEntry, clientCode, declaredNames, { client: true })
  assertNoDeadDependencies(fail, config.entry, nodeCode, new Set(Object.keys(production)))
  // The shared kit must be CONSUMED at runtime from the base, never inlined: inlining its helpers
  // would make a shared-helper fix need a plugin release, and nothing else in the artifact shows it.
  if (nodeCode.includes(KIT_MARKER)) {
    fail(`${config.entry}: carries the base kit's implementation ("${KIT_MARKER}") — shared helpers are consumed from the base at runtime, never inlined`)
  }

  // ── the framework: a peer, never bundled, with the bootstrap inlined ──────────────────────────
  const vendoredPath = join(pluginDir, 'src', 'envinit-bootstrap.js')
  const vendoredBootstrap = existsSync(vendoredPath) ? readFileSync(vendoredPath, 'utf8') : undefined
  const inliningMarker = vendoredBootstrap === undefined
    ? undefined
    : /supportedRange\s*=\s*['"]([^'"]+)['"]/.exec(vendoredBootstrap)?.[1]

  /** The text that must carry the framework's supportedRange marker for this tree's bootstrap shape. */
  const markerText = () => (config.bootstrap === 'inlined'
    ? nodeCode
    : (existsSync(join(pluginDir, config.bootstrapFile)) ? readFileSync(join(pluginDir, config.bootstrapFile), 'utf8') : ''))

  if (config.bootstrap === 'inlined') {
    if (/(?:from|import\s*\()\s*['"][^'"]*envinit-bootstrap\.js['"]/.test(nodeCode)) {
      fail(`${config.entry}: the vendored bootstrap is still a relative import — it was not inlined`)
    }
    if (vendoredBootstrap === undefined) {
      fail(`${config.entry}: ${vendoredPath} is missing — run \`node scripts/link-envinit.mjs\``)
    } else if (inliningMarker === undefined) {
      fail(`${config.entry}: ${vendoredPath} has no supportedRange literal to look for in the bundle`)
    } else if (!nodeCode.includes(inliningMarker)) {
      fail(`${config.entry}: the inlined bootstrap is missing (no supportedRange ${inliningMarker} literal)`)
    }
  } else {
    const bootstrapPath = join(pluginDir, config.bootstrapFile)
    if (!importSpecifiers(nodeCode).includes(`./${config.bootstrapFile.replace(/^lib\//u, '')}`)) {
      fail(`${config.entry}: does not import the inlined bootstrap by relative path (expected ./${config.bootstrapFile.replace(/^lib\//u, '')})`)
    }
    if (!existsSync(bootstrapPath)) {
      fail(`${config.entry}: ${config.bootstrapFile} is missing — the bootstrap is not shipped`)
    } else {
      const foreign = importSpecifiers(readFileSync(bootstrapPath, 'utf8')).filter((specifier) => !specifier.startsWith('node:'))
      if (foreign.length > 0) fail(`${config.entry}: the bootstrap imports non-node modules: ${foreign.join(', ')}`)
      if (inliningMarker === undefined || !markerText().includes(inliningMarker)) {
        fail(`${config.entry}: ${config.bootstrapFile} does not carry the framework's supportedRange literal`)
      }
    }
    if (staticImportSpecifiers(nodeCode).includes(FRAMEWORK_PEER)) {
      fail(`${config.entry}: has a STATIC value import of ${FRAMEWORK_PEER} — it must be type-only or dynamic, or a missing peer makes the whole module unloadable`)
    }
  }

  // The inlined/vendored bootstrap must be the SAME framework version this checkout installed.
  const installedManifest = join(pluginDir, 'node_modules', FRAMEWORK_PEER, 'package.json')
  if (!existsSync(installedManifest)) {
    fail(`the installed ${FRAMEWORK_PEER} is missing — run \`pnpm install\` (the base is a plain dependency, linked from the workspace)`)
  } else {
    const installedVersion = JSON.parse(readFileSync(installedManifest, 'utf8')).version
    const installedBootstrap = join(pluginDir, 'node_modules', FRAMEWORK_PEER, 'dist', 'bootstrap.js')
    if (!existsSync(installedBootstrap)) {
      fail(`${FRAMEWORK_PEER} ${String(installedVersion)} carries no dist/bootstrap.js — the install is not a built framework`)
    } else {
      const installedVendored = readBootstrapVersion(installedBootstrap)
      if (installedVendored !== installedVersion) {
        fail(`the installed ${FRAMEWORK_PEER}'s bootstrap declares ${String(installedVendored)} but its package.json is ${String(installedVersion)}`)
      }
      const inlined = readBootstrapVersion(vendoredPath)
      if (inlined !== installedVersion) {
        fail(`the vendored bootstrap declares ${String(inlined)} but the installed ${FRAMEWORK_PEER} is ${String(installedVersion)} — re-vendor with \`node scripts/link-envinit.mjs\` and rebuild`)
      }
    }
  }

  // ── the browser half: no framework reached, no kit inlined ────────────────────────────────────
  if (specifiersIn(clientCode).some((specifier) => specifier.startsWith('@avantf/'))) {
    fail(`${config.clientEntry}: the browser half must not reach any @avantf/* package`)
  }
  if (clientCode.includes(KIT_MARKER)) {
    fail(`${config.clientEntry}: carries the base kit's implementation ("${KIT_MARKER}") — the browser half must not inline the kit`)
  }

  // ── the bake and the gate's version list ──────────────────────────────────────────────────────
  const bakedPath = join(pluginDir, 'lib', 'dsh-build.json')
  if (!existsSync(bakedPath)) {
    fail('lib/dsh-build.json is missing — run scripts/link-dsh.mjs so the gate knows what this build compiled against')
  } else {
    const baked = JSON.parse(readFileSync(bakedPath, 'utf8'))
    for (const pkg of ['@deepseek-ai/dsh-tools', '@deepseek-ai/dsh-typert-protocol']) {
      if (typeof baked[pkg] !== 'string' || baked[pkg] === '') fail(`dsh-build.json has no version for ${pkg}`)
    }
    // Every baked entry is re-resolved HERE and must equal the JSON: an unrelinked build keeps a bake
    // line for a dsh it no longer resolves, and the gate would report `ok` on exactly that drift.
    const require = createRequire(entry)
    for (const [pkg, want] of Object.entries(baked)) {
      const got = linkedVersion(require, pkg)
      if (got === want) continue
      fail(
        `dsh-build.json is out of step with this build's links — ${pkg} baked=${String(want)} linked=${got}`
        + (got.startsWith('UNRESOLVED')
          ? ' (the package does not resolve from this artifact at all — run scripts/link-dsh.mjs --runtime)'
          : ' (the bake is stale or the links moved; run pnpm build:dsh, without --skip-link)'),
      )
    }
    // The gate reads only the packages its list NAMES; each must be baked, or the gate silently falls
    // back to the peer range's floor. The reverse (every baked package is named) is asserted too,
    // except for a tree that deliberately bakes the whole linked set (see `allowBakedSuperset`).
    const source = readFileSync(join(pluginDir, config.versionPackagesFile), 'utf8')
    const declaredList = /const VERSION_PACKAGES: readonly string\[\] = \[([\s\S]*?)\]/u.exec(source)?.[1]
    if (declaredList === undefined) {
      fail(`src/${config.versionPackagesFile.replace(/^src\//u, '')} no longer declares VERSION_PACKAGES — the gate's version list cannot be verified against the bake`)
    } else {
      const listed = new Set(versionPackageNames(declaredList))
      for (const pkg of listed) {
        if (baked[pkg] === undefined) {
          fail(`VERSION_PACKAGES names ${pkg} but dsh-build.json does not bake it — the gate would fall back to the peer range's lower bound instead of this build's version`)
        }
      }
      if (!config.allowBakedSuperset) {
        for (const pkg of Object.keys(baked)) {
          if (!listed.has(pkg)) {
            fail(`dsh-build.json bakes ${pkg} but VERSION_PACKAGES does not name it — the compatibility gate would not notice it drifting`)
          }
        }
      }
    }
  }

  // ── the baked interface record ────────────────────────────────────────────────────────────────
  const interfaceRecord = join(pluginDir, 'lib', 'interface-version.json')
  if (!existsSync(interfaceRecord)) {
    fail('lib/interface-version.json is missing — run scripts/link-envinit.mjs so the interface gate knows which base generation this build was written for')
  } else {
    const record = JSON.parse(readFileSync(interfaceRecord, 'utf8'))
    if (!Number.isInteger(record.interfaceVersion) || record.interfaceVersion <= 0) {
      fail(`interface-version.json declares no positive integer interfaceVersion (found ${JSON.stringify(record.interfaceVersion)})`)
    }
    if (typeof record.baseVersion !== 'string' || record.baseVersion === '') {
      fail('interface-version.json has no baseVersion — the record does not say which base it was taken from')
    }
  }

  return { problems }
}

/** Directories never walked when building the consumer corpus (build output is not a consumer). */
const SOURCE_SKIP_DIRS = new Set(['node_modules', 'lib', 'dist', 'release', 'coverage', '.git'])
const SOURCE_FILE = /\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/u

/**
 * The workspace root: the nearest ancestor of a tree's `config.repo` that carries `pnpm-workspace.yaml`.
 *
 * `config.repo` is the TREE (`<workspace>/mem`), because the mount smoke script resolves against it;
 * the consumer corpus spans the sibling trees, so the observation needs the workspace above it.
 * `undefined` means the layout is not what we think it is, and the observation stays silent rather
 * than calling every symbol dead against an empty corpus.
 */
function workspaceRoot(repo) {
  let dir = resolve(repo)
  for (;;) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir
    const up = dirname(dir)
    if (up === dir) return undefined
    dir = up
  }
}

/** Every source text under `<workspace>/{base,mem,mission,identity}` — the corpus the dead-export observation searches. */
function repoSourceTexts(repo) {
  const texts = []
  const walk = (dir) => {
    let entries
    try { entries = readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const path = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (!SOURCE_SKIP_DIRS.has(entry.name) && !entry.name.startsWith('.')) walk(path)
        continue
      }
      if (!SOURCE_FILE.test(entry.name)) continue
      try { texts.push(readFileSync(path, 'utf8')) } catch { /* an unreadable source excludes nothing */ }
    }
  }
  for (const tree of ['base', 'mem', 'mission', 'identity']) walk(join(repo, tree))
  return texts
}

/** The base's frozen interface members, from every generation record in the checkout. */
function frozenInterfaceNames(repo) {
  const names = new Set()
  const apiDir = join(repo, 'base', 'plugin-base', 'api')
  let records
  try { records = readdirSync(apiDir) } catch { return names }
  for (const file of records) {
    if (!/^interface-v\d+\.json$/u.test(file)) continue
    try {
      const record = JSON.parse(readFileSync(join(apiDir, file), 'utf8'))
      for (const name of [...(record.exportedValueNames ?? []), ...(record.exportedTypeNames ?? [])]) names.add(name)
    } catch { /* a record we cannot read excludes nothing */ }
  }
  return names
}

/** Exported names a declaration re-exports straight from an `@avantf/*` package: deliberate mirrors. */
function mirrorExportNames(declarationText) {
  const names = []
  for (const match of declarationText.matchAll(/^export\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"]@avantf\//gmu)) {
    names.push(...exportListNames(match[1]))
  }
  return names
}

/**
 * The dead-export OBSERVATION printed by a pack run — one line, never a gate.
 *
 * WHY IT IS AN OBSERVATION AND NOT AN ASSERTION. This repo's rule is that a gate must prove one
 * thing; "how many shipped exports has nothing in the repo ever consumed" proves nothing on its own.
 * A plugin's entry exports are consumed by the HOST, so an in-repo count cannot decide that any of
 * them is removable — it can only make the rate of accumulation visible. So the number is printed and
 * never checked: no `fail`, no exit code, and any unreadable or unparsable artifact degrades to
 * silence rather than becoming a new failure source.
 *
 * The COUNTING is text-level and honest about it:
 *  - the surface is every shipped `package/lib/**\/*.d.ts` (the same set the peer scan above reads);
 *    the engine's carried declarations are part of it, because that is where dead exports actually
 *    sediment — a `lib/types`-only scan reads clean while the carried API rots;
 *  - the corpus is every `.ts/.tsx/.js/.mjs` under `base/`, `mem/`, `mission/` outside build output
 *    (`node_modules`, `lib`, `dist`), and a name is consumed once it occurs twice there — the
 *    declaration plus one use;
 *  - the base's frozen interface members and any symbol a declaration mirrors straight out of an
 *    `@avantf/*` package are excluded by name, so deliberately frozen/mirrored members are never
 *    reported as dead.
 *
 * @returns the note text, or `undefined` when there is nothing to report or anything went wrong.
 */
export function shippedDeclarationNote(config, entries, read) {
  try {
    if (typeof config.repo !== 'string') return undefined
    const declarations = entries.filter((entry) => entry.startsWith('package/lib/') && entry.endsWith('.d.ts'))
    if (declarations.length === 0) return undefined
    const declarationText = declarations.map((entry) => read(entry)).join('\n')
    if (declarationText.trim() === '') return undefined
    const workspace = workspaceRoot(config.repo)
    if (workspace === undefined) return undefined
    const sources = repoSourceTexts(workspace)
    if (sources.length === 0) return undefined
    const exclude = [...frozenInterfaceNames(workspace), ...mirrorExportNames(declarationText)]
    const { exported, unconsumed } = unconsumedExports(declarationText, sources, { exclude })
    return `note  shipped declarations: ${String(exported)} exported symbols, ${String(unconsumed)} with no in-repo consumer (approximate — mirrors and frozen interface members are excluded)`
  } catch {
    return undefined
  }
}

/** The small Chinese numerals the published READMEs use in prose (`三段` = 3, `两条` = 2). */
const DOCUMENTED_COUNTS = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 }

/**
 * The number a document states, from a claim's first capture group — a digit string, or one of the
 * small Chinese numerals the READMEs write in prose. `undefined` when it is neither.
 */
export function documentedCount(raw) {
  const text = String(raw).trim()
  if (/^\d+$/u.test(text)) return Number(text)
  return DOCUMENTED_COUNTS[text]
}

/**
 * Compare the counts a PUBLISHED document states about itself with the counts the code produces.
 *
 * Each claim is `{ label, text, pattern, measured }`:
 *  - `text` — the document's content, or `undefined` when it could not be read;
 *  - `pattern` — a regex whose FIRST capture group is the documented number (`(\d+)`, or a Chinese
 *    numeral class); it must not carry the `g` flag, or `exec` would carry state between claims;
 *  - `measured` — the number the code actually produces, or `undefined` when unmeasurable.
 *
 * An undecidable claim is SILENT: an unreadable document, a number the document does not state, or a
 * measurement the tree could not compute yields nothing at all. This feeds an OBSERVATION (see the
 * module header), so it must never manufacture a finding out of a missing input — the only thing it
 * may report is a genuine disagreement between two numbers it actually holds.
 *
 * @returns one line per mismatch, in claim order; empty when everything agrees or nothing is decidable.
 */
export function documentedCountMismatches(claims) {
  const lines = []
  for (const claim of claims) {
    if (typeof claim.text !== 'string') continue
    if (typeof claim.measured !== 'number' || !Number.isFinite(claim.measured)) continue
    const match = claim.pattern.exec(claim.text)
    if (match === null) continue
    const documented = documentedCount(match[1])
    if (documented === undefined) continue
    if (documented === claim.measured) continue
    lines.push(`${claim.label}: documented ${String(documented)}, measured ${String(claim.measured)}`)
  }
  return lines
}

/**
 * The published documents this pack can cross-check, and the number each claim should state.
 *
 * Every claim names the document, the regex whose first capture is the number AS WRITTEN, and the
 * measurement read from the code that produces it. A measurement that cannot be taken (`undefined`)
 * makes its claim silent rather than wrong — see {@link documentedCountMismatches}.
 *
 * WHY THE REMINDER IS HERE. **改可观察行为必须同步 README/DESIGN.** Adding a tool, retiring a command
 * or merging a prompt section is a MINOR change that must land with its documentation: the shipped
 * README IS the npm page, and AGENTS.md is what the next contributor reads. A stale number in a
 * published document is a defect (AGENTS.md「发布 README 的内容要求」), not cosmetics. This is the one
 * place every release passes through, so it is where the drift is made visible.
 */
function documentationCountClaims(read) {
  const memTools = arrayEntries(read('mem/packages/contract/src/tools.ts'), 'TOOL_SPECS')?.length
  const memSections = arrayEntries(read('mem/packages/plugin/src/prompt.ts'), 'PROMPT_FILES')?.length
  const missionSections = arrayEntries(read('mission/packages/plugin/src/prompt.ts'), 'PROMPT_FILES')?.length
  const missionTools = (() => {
    const source = read('mission/packages/plugin/src/tools.ts')
    if (typeof source !== 'string') return undefined
    const found = (source.match(/^\s*name: '[a-z][a-z_]*',\s*$/gmu) ?? []).length
    return found === 0 ? undefined : found
  })()
  const missionCommands = (() => {
    const source = read('mission/packages/plugin/src/index.ts')
    if (typeof source !== 'string') return undefined
    const found = (source.match(/ctx\.commands\.register\s*\(/gu) ?? []).length
    return found === 0 ? undefined : found
  })()

  const memReadme = read('mem/packages/plugin/README.md')
  const missionReadme = read('mission/packages/plugin/README.md')
  const agents = read('AGENTS.md')
  return [
    { label: 'mem README model tools', text: memReadme, pattern: /(\d+)\s*个模型工具/u, measured: memTools },
    { label: 'mem README prompt sections', text: memReadme, pattern: /([一二三四五六七八九十两])\s*段\*{0,2}\s*用法提示/u, measured: memSections },
    { label: 'AGENTS.md mem model tools', text: agents, pattern: /（(\d+)\s*个模型工具/u, measured: memTools },
    { label: 'AGENTS.md mem tool face', text: agents, pattern: /工具面就是[^0-9]*(\d+)\s*个/u, measured: memTools },
    { label: 'mission README model tools', text: missionReadme, pattern: /(\d+)\s*个模型工具/u, measured: missionTools },
    { label: 'mission README commands', text: missionReadme, pattern: /([一二三四五六七八九十两])\s*条命令/u, measured: missionCommands },
    { label: 'mission README prompt sections', text: missionReadme, pattern: /([一二三四五六七八九十两])\s*段静态系统提示词段/u, measured: missionSections },
  ]
}

/**
 * The documented-count OBSERVATION printed by a pack run — one line, never a gate.
 *
 * The counts in a shipped README are the npm page: "8 个模型工具", "9 个模型工具 / 三条命令", a prompt
 * section count. Each is produced by code somewhere in this repo, so each can be cross-checked —
 * and a number that no longer matches is a defect the type-checker cannot see. Like the dead-export
 * note above, this PRINTS and never checks: no `fail`, no exit code, and any unreadable document or
 * unmeasurable count degrades to silence rather than becoming a new failure source.
 *
 * @returns the note text, or `undefined` when every count agrees or nothing could be decided.
 */
export function documentationCountNote(config) {
  try {
    if (typeof config.repo !== 'string') return undefined
    const workspace = workspaceRoot(config.repo)
    if (workspace === undefined) return undefined
    const read = (relative) => {
      try { return readFileSync(join(workspace, relative), 'utf8') } catch { return undefined }
    }
    const mismatches = documentedCountMismatches(documentationCountClaims(read))
    if (mismatches.length === 0) return undefined
    return `note  documented counts: ${mismatches.join('; ')} (a published README/AGENTS number no longer matches the code — 改可观察行为必须同步 README/DESIGN)`
  } catch {
    return undefined
  }
}

/**
 * The tarball-side assertions: what the registry would actually serve. Runs on the bytes, so a
 * `files` whitelist that drops a needed file or lets a stale one through is caught here and nowhere
 * else.
 *
 * @param config.libAllow - the regex of `lib/` entries this tree intends to ship; anything else is a
 *   stale build riding along.
 * @param config.requiredEntries - tarball entries that must exist.
 * @param config.carriedTypesDir - where the unpublished engine's declarations are carried.
 * @returns `{ problems, notes }`.
 */
export function assertTarball(config, tarball) {
  const problems = []
  const fail = (message) => problems.push(message)
  const { manifest, production, declaredNames } = contextOf(config)
  const contents = readTarEntries(tarball)
  const read = (entry) => readTarFile(tarball, entry)
  const packed = JSON.parse(read('package/package.json'))
  const packedDeclared = new Set([
    ...Object.keys(packed.dependencies ?? {}),
    ...Object.keys(packed.optionalDependencies ?? {}),
    ...Object.keys(packed.peerDependencies ?? {}),
  ])

  // ── the packed manifest ───────────────────────────────────────────────────────────────────────
  // `devDependencies` deliberately are NOT asserted: `pnpm pack` rewrites the release manifest's
  // `workspace:*` engine entries into plain versions, so the packed manifest carries build-time traces
  // of packages that are not on npm. That is harmless — npm never installs a dependency's
  // devDependencies — and the production sections below are the ones a consumer's install resolves.
  for (const section of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
    for (const name of Object.keys(packed[section] ?? {})) {
      if (name.startsWith('@avantf/') && name !== FRAMEWORK_PEER) {
        fail(`tarball ${section}: "${name}" is an engine package — it must ship inlined, so the packed package depends on nothing under @avantf/ except the ${FRAMEWORK_PEER} peer`)
      }
    }
  }
  for (const section of ['dependencies', 'optionalDependencies']) {
    const expected = Object.keys(manifest[section] ?? {}).sort().join(', ')
    const actual = Object.keys(packed[section] ?? {}).sort().join(', ')
    if (actual !== expected) fail(`tarball ${section} is "${actual}" but the manifest declares "${expected}"`)
  }
  for (const section of ['dependencies', 'optionalDependencies', 'peerDependencies', 'devDependencies']) {
    for (const [name, range] of Object.entries(packed[section] ?? {})) {
      // `link:`/`file:` too: the workspace resolves `@avantf/dsh-plugin-base` from a sibling checkout
      // during development, and a tarball carrying that is unpublishable.
      if (typeof range === 'string' && /^(catalog:|workspace:|link:|file:)/.test(range)) {
        fail(`tarball ${section}: "${name}": "${range}" is a workspace-only specifier — publish the sibling and pin a registry range first`)
      }
    }
  }
  // `files` must ship `lib/` — as the directory (mem) or as explicit `lib/...` entries (mission).
  const filesList = packed.files ?? []
  if (!filesList.includes('lib') && !filesList.some((entry) => typeof entry === 'string' && entry.startsWith('lib/'))) {
    fail('tarball manifest: `files` does not ship lib/')
  }
  for (const [label, value] of [['main', packed.main], ['types', packed.types]]) {
    if (typeof value !== 'string' || !value.startsWith('lib/')) fail(`tarball manifest: ${label} must point into lib/`)
  }
  if (packed.exports?.['./client'] === undefined) fail('tarball manifest: exports["./client"] is missing (the browser half)')
  if (packed.dsh?.client?.platform !== 'web') fail('tarball manifest: dsh.client.platform must be "web"')
  if (typeof packed.dependencies?.[FRAMEWORK_PEER] !== 'string') {
    fail(`tarball manifest: "${FRAMEWORK_PEER}" must be a runtime dependency (installing the plugin installs the base)`)
  }

  // ── the npm page and the license ──────────────────────────────────────────────────────────────
  // The npm page is the package's OWN README: assert it ships and that its title names this package,
  // or a copy/rename slip would publish another package's page and nothing else would notice.
  if (!contents.includes('package/LICENSE')) {
    fail(`${tarball}: missing LICENSE — npm ships the license file beside package.json, and its absence is a compliance gap, not a cosmetic one`)
  }
  if (!contents.includes('package/README.md')) {
    fail(`${tarball}: missing README.md — the npm page has to be the package's own README`)
  } else {
    const readme = read('package/README.md')
    if (readme.trim() === '') {
      fail(`${tarball}: missing README.md — the npm page has to be the package's own README`)
    } else if (readme.split('\n')[0]?.trim() !== `# ${String(packed.name)}`) {
      fail(`${tarball}: README.md starts with ${JSON.stringify(readme.split('\n')[0])}, expected "# ${String(packed.name)}"`)
    }
  }
  for (const entry of config.requiredEntries) {
    if (!contents.includes(entry)) fail(`tarball is missing ${entry}`)
  }

  // ── no stale build rides along ────────────────────────────────────────────────────────────────
  // `lib/` is however many files the LAST build left there, and the bundler does not clean it: a
  // build made with a different manifest section split emits extra chunks, and the next build leaves
  // them behind. They are unreferenced by the bundles, so nothing else notices. Pin the shipped set.
  const strays = contents.filter((entry) => entry.startsWith('package/lib/') && !config.libAllow.test(entry))
  if (strays.length > 0) {
    fail(`tarball carries ${String(strays.length)} file(s) under lib/ that no bundle references (a stale build — rerun \`pnpm build:dsh\` on a clean lib/): ${strays.join(', ')}`)
  }

  // ── the bundles ───────────────────────────────────────────────────────────────────────────────
  const entryPath = `package/${config.entry}`
  const clientPath = `package/${config.clientEntry}`
  const nodeCode = read(entryPath)
  const clientCode = read(clientPath)
  assertSelfContained(fail, `tarball:${config.entry}`, nodeCode, packedDeclared, {
    client: false,
    allowRelative: config.bootstrap === 'copied',
  })
  assertSelfContained(fail, `tarball:${config.clientEntry}`, clientCode, packedDeclared, { client: true })
  if (specifiersIn(clientCode).some((specifier) => specifier.startsWith('@avantf/'))) {
    fail(`tarball:${config.clientEntry}: the browser half must not reach any @avantf/* package`)
  }
  if (clientCode.includes(KIT_MARKER)) {
    fail(`tarball:${config.clientEntry}: carries the base kit's implementation ("${KIT_MARKER}") — the browser half must not inline the kit`)
  }
  if (config.bootstrap === 'inlined') {
    const vendoredBootstrap = existsSync(join(config.pluginDir, 'src', 'envinit-bootstrap.js'))
      ? readFileSync(join(config.pluginDir, 'src', 'envinit-bootstrap.js'), 'utf8')
      : undefined
    const marker = vendoredBootstrap === undefined
      ? undefined
      : /supportedRange\s*=\s*['"]([^'"]+)['"]/.exec(vendoredBootstrap)?.[1]
    if (marker === undefined) fail(`tarball:${config.entry}: no supportedRange literal to look for`)
    else if (!nodeCode.includes(marker)) fail(`tarball:${config.entry}: the inlined bootstrap is missing (no supportedRange ${marker} literal)`)
  } else {
    const bootstrapEntry = `package/${config.bootstrapFile}`
    if (!contents.includes(bootstrapEntry)) {
      fail(`tarball: ${config.bootstrapFile} is missing — the inlined bootstrap is not shipped`)
    } else if (!importSpecifiers(nodeCode).includes(`./${config.bootstrapFile.replace(/^lib\//u, '')}`)) {
      fail(`tarball:${config.entry}: does not import the inlined bootstrap by relative path`)
    } else {
      const foreign = importSpecifiers(read(bootstrapEntry)).filter((specifier) => !specifier.startsWith('node:'))
      if (foreign.length > 0) fail(`tarball:${config.bootstrapFile}: imports non-node modules: ${foreign.join(', ')}`)
    }
    if (staticImportSpecifiers(nodeCode).includes(FRAMEWORK_PEER)) {
      fail(`tarball:${config.entry}: has a STATIC value import of ${FRAMEWORK_PEER}`)
    }
  }

  // ── every shipped file only names what a consumer's install provides ──────────────────────────
  // This is the union of the sibling trees' peer scans: EVERY shipped `.js`/`.d.ts` outside the
  // browser half is scanned (mission's scope), a `.d.ts` may type-import any harness module
  // (mem's allowance), and any surviving `@avantf/*` engine name is an error in either extension.
  const shippedCode = contents.filter((entry) => /^package\/lib\/.*\.(?:js|d\.ts)$/u.test(entry) && !isBrowserHalf(insidePackage(entry)))
  let foundSpecifiers = 0
  for (const entry of shippedCode) {
    if (entry === entryPath || entry === clientPath) continue
    const rel = insidePackage(entry)
    const code = read(entry)
    const types = entry.endsWith('.d.ts')
    if (entry.endsWith('.js') && code.includes(KIT_MARKER)) {
      fail(`tarball:${rel}: carries the base kit's implementation ("${KIT_MARKER}") — share it by dynamic import from the base, never by inlining`)
    }
    assertSelfContained(fail, `tarball:${rel}`, code, packedDeclared, { client: false, allowFramework: types, allowRelative: true, types })
    for (const specifier of importSpecifiers(code)) {
      if (specifier.startsWith('.') || specifier.startsWith('node:')) continue
      foundSpecifiers += 1
      const name = packageName(specifier)
      if (name.startsWith('@avantf/') && name !== FRAMEWORK_PEER) {
        fail(`tarball:${rel}: names "${specifier}" — the engine is not published, so its runtime must be inlined and its declarations carried and repointed`)
        continue
      }
      if (types && name.startsWith('@deepseek-ai/')) continue
      if (!packedDeclared.has(name)) {
        fail(`tarball:${rel}: imports "${name}" but no dependency/peer declares it`)
      }
    }
  }
  const declaredDeepseek = [...packedDeclared].filter((name) => name.startsWith('@deepseek-ai/'))
  if (declaredDeepseek.length > 0 && foundSpecifiers === 0) {
    fail(`declares ${String(declaredDeepseek.length)} @deepseek-ai peer(s) but no shipped file imports any — the scan is broken, not the package`)
  }

  // ── the dead-export OBSERVATION (never a gate): how fast the shipped surface sediments ────────
  // Printed, never checked — see `shippedDeclarationNote`. It cannot fail a pack by construction, and
  // if the artifact or the checkouts cannot be read it says nothing at all.
  const declarationNote = shippedDeclarationNote(config, contents, read)
  if (declarationNote !== undefined) console.log(declarationNote)

  // ── the documented-count OBSERVATION (never a gate): a stale number in a published README ─────
  // **改可观察行为必须同步 README/DESIGN** — a tool added or a command retired must land with the doc
  // that counts it (AGENTS.md「发布 README 的内容要求」). Printed, never checked, exactly like the
  // dead-export note above: an unreadable doc or an unmeasurable count says nothing.
  const countNote = documentationCountNote(config)
  if (countNote !== undefined) console.log(countNote)

  // ── the relative-import closure of the shipped declaration tree ────────────────────────────────
  // The carry step repoints `@avantf/<engine>` to relative specifiers. Nothing checked the other end:
  // a partial copy ships a specifier that resolves to nothing, and the peer scan skips relative
  // specifiers on purpose. Every relative specifier must land on a file the tarball also carries.
  const shippedEntries = new Set(contents)
  const dangling = []
  let relativeSpecifiers = 0
  for (const entry of shippedCode) {
    for (const specifier of importSpecifiers(read(entry))) {
      if (!specifier.startsWith('.')) continue
      relativeSpecifiers += 1
      const target = posix.normalize(posix.join(posix.dirname(entry), specifier))
      const candidates = specifier.endsWith('.js')
        ? [target, target.replace(/\.js$/u, '.d.ts'), `${target}.d.ts`]
        : [target, `${target}.d.ts`, `${target}/index.js`, `${target}/index.d.ts`]
      if (!candidates.some((candidate) => shippedEntries.has(candidate))) dangling.push(`${entry} → ${specifier}`)
    }
  }
  // A tree with NO unpublished engine (identity) has nothing to carry, and says so by omitting
  // `carriedTypesDir`. Asserting it would fail a package whose declarations are already complete.
  if (config.carriedTypesDir !== undefined) {
    const carried = contents.filter((entry) => entry.startsWith(`package/${config.carriedTypesDir}/`))
    if (carried.length === 0) {
      fail(`tarball: no ${config.carriedTypesDir}/**/*.d.ts shipped — the engine's declarations were not carried (or \`files\` dropped them), so the declared types still point at unpublished packages`)
    }
    if (relativeSpecifiers === 0 && carried.length > 0) {
      fail(`tarball: the shipped declaration tree carries ${config.carriedTypesDir}/ but no relative specifier was found — the closure scan is broken, not the package`)
    }
  }
  if (dangling.length > 0) {
    fail(`tarball: ${String(dangling.length)} dangling relative import(s) in the shipped declarations — a repoint or a \`files\` pattern would ship a specifier that resolves to nothing: ${dangling.slice(0, 5).join(', ')}`)
  }

  void declaredNames
  return { problems }
}

/**
 * The mount phase: extract the packed tarball into a scratch profile and mount it twice — once with
 * the base linked (the gate runs off it) and once with nothing able to resolve it (the plugin must
 * still mount through the legacy path). `prepare` links the runtime externals a tree's own install
 * would have put beside the package.
 *
 * @param options.packageDirName - the directory the extracted `package/` is renamed to (`dsh-mem`).
 * @param options.prepare - `({ scratch, scope, packageDir, linkBase, fail, note }) => void`.
 */
export function mountAllVariants({ tarball, repo, keep, fail, note, scratchPrefix, smokeArgs, absentEnv, packageDirName, prepare }) {
  const mountVariant = (label, { linkBase }) => {
    const scratch = mkdtempSync(join(tmpdir(), scratchPrefix))
    const scope = join(scratch, 'node_modules', '@avantf')
    mkdirSync(scope, { recursive: true })
    const packageDir = join(scope, packageDirName)
    console.log(`\n▶ [${label}] extract ${tarball}\n  → ${packageDir}`)
    const extracted = spawnSync('tar', ['-xzf', tarball, '-C', scope], { stdio: 'inherit' })
    if (extracted.status !== 0) {
      fail(`cannot extract the tarball [${label}]`)
      if (keep) note(`scratch[${label}] kept: ${scratch}`)
      else rmSync(scratch, { recursive: true, force: true })
      return
    }
    renameSync(join(scope, 'package'), packageDir)
    // A tree whose variant cannot be prepared (the base peer is not installed) aborts THAT variant
    // instead of running a mount that would prove nothing.
    if (prepare({ scratch, scope, packageDir, linkBase, fail, note }) === false) {
      if (keep) note(`scratch[${label}] kept: ${scratch}`)
      else rmSync(scratch, { recursive: true, force: true })
      return
    }
    const status = spawnSync(process.execPath, [join(repo, 'scripts', 'mount-smoke.mjs'), ...smokeArgs], {
      stdio: 'inherit',
      env: {
        ...process.env,
        AVANTF_PLUGIN_DIR: packageDir,
        AVANTF_MOUNT_SCRATCH: scratch,
        ...(linkBase ? {} : { [absentEnv]: '1' }),
      },
    }).status
    if (status !== 0) {
      fail(`the packed tarball did not mount [${label}] (see the mount smoke output above)`)
      if (keep) note(`scratch[${label}] kept: ${scratch}`)
      else rmSync(scratch, { recursive: true, force: true })
    } else {
      rmSync(scratch, { recursive: true, force: true })
    }
  }
  mountVariant('base linked', { linkBase: true })
  mountVariant('base unresolvable', { linkBase: false })
}

/** Print the collected findings and exit non-zero when there are any. */
export function report(problems, notes, okMessage) {
  for (const message of notes) console.log(`note: ${message}`)
  if (problems.length > 0) {
    console.error(`\npack-plugin FAILED (${String(problems.length)}):`)
    for (const problem of problems) console.error(`  - ${problem}`)
    process.exit(1)
  }
  console.log(`\n✓ ${okMessage}`)
}
