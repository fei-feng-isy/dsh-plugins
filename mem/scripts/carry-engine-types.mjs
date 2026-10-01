#!/usr/bin/env node
/**
 * Carry the engine's DECLARATIONS into the plugin's shipped tree, and repoint every surviving
 * `@avantf/mem*` specifier at them.
 *
 * The plugin is published as ONE package: the engine (`@avantf/mem-contract` → `@avantf/mem-core` →
 * `@avantf/mem`) sits in `devDependencies`, so the harness tsdown preset folds its RUNTIME into
 * `lib/index.js`. Types are the other half of that promise and are NOT bundled: `tsc` emits
 * `lib/types/*.d.ts` verbatim, and `exports["."].types` points straight at `lib/types/index.d.ts`. A
 * `from '@avantf/mem'` left in there is an unresolvable specifier for a consumer — `@avantf/mem` is
 * not on npm, so their type-check stops at TS2307 (this shipped for real in 0.3.1). The published
 * declaration surface must therefore name only packages a user's install resolves: the required
 * `@avantf/dsh-plugin-base` peer, `@deepseek-ai/*` peers, `zod`, and relative paths INSIDE this
 * package.
 *
 * The fix is the one `mission/scripts/build.mjs` (`inlineCoreTypes`) already uses and that its tarball
 * proves: copy the engine's declarations under `lib/engine/<package>/` (shipped with `lib`) and rewrite
 * the package specifiers to relative paths. Copied, never re-declared — the declarations reference
 * each other by relative path, and the copy has to keep the same shape for those to resolve.
 *
 * The set carried is the DECLARATION CLOSURE of `lib/types`, not every workspace package: the
 * plugin's own declarations name `@avantf/mem` and `@avantf/mem-contract`, whose declarations name
 * `@avantf/mem-core`, and so on. A package nothing reaches (the CLI/MCP in this checkout) is never
 * copied — shipping its declarations would be dead weight and a second surface to keep repointed.
 * `scripts/pack-plugin.mjs` then scans every shipped `.d.ts`/`.js` under `lib/` and fails if any
 * unpublished `@avantf/*` specifier survives, so this step cannot silently regress.
 *
 * The workspace packages are discovered from `packages/*` (like the build and the root release gate),
 * never hardcoded: the release tree ships a subset of this checkout's packages, and a hardcoded list
 * would either crash there or drift.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const pluginDir = join(repo, 'packages', 'plugin')
const pluginTypes = join(pluginDir, 'lib', 'types')
const engineRoot = join(pluginDir, 'lib', 'engine')
const PREFIX = '@avantf/'
/** The one published `@avantf/*` name a shipped declaration MAY keep: the required base peer. */
const FRAMEWORK_PEER = '@avantf/dsh-plugin-base'

/** Every workspace package whose declarations could be carried: `name` → `{ source, destination }`. */
const available = new Map()
for (const entry of readdirSync(join(repo, 'packages'), { withFileTypes: true })) {
  if (!entry.isDirectory() || entry.name === 'plugin') continue
  const dir = join(repo, 'packages', entry.name)
  const manifestPath = join(dir, 'package.json')
  if (!existsSync(manifestPath)) continue
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const name = manifest.name
  if (typeof name !== 'string' || !name.startsWith(PREFIX)) continue
  if (!existsSync(join(dir, 'lib'))) continue
  available.set(name, { source: join(dir, 'lib'), destination: join(engineRoot, name.slice(PREFIX.length)) })
}
if (available.size === 0) {
  console.error('carry-engine-types: no engine packages found under packages/ — refusing to "succeed" with nothing to carry')
  process.exit(1)
}
if (!existsSync(pluginTypes)) {
  console.error(`carry-engine-types: ${pluginTypes} is missing — run \`tsc\` first (this step sits after it in the build)`)
  process.exit(1)
}

/** The bare import specifiers of a declaration file (not a prose mention of a package name). */
function importSpecifiers(code) {
  const found = new Set()
  for (const pattern of [
    /^\s*import\s[^;]*?from\s*["']([^"']+)["']/gm,
    /^\s*export\s[^;]*?from\s*["']([^"']+)["']/gm,
    /import\(\s*["']([^"']+)["']\s*\)/g,
  ]) {
    for (const match of code.matchAll(pattern)) found.add(match[1])
  }
  return found
}

/** `@avantf/x/y` → the workspace package name `@avantf/x`, or undefined for a non-@avantf specifier. */
function packageOf(specifier) {
  if (!specifier.startsWith(PREFIX)) return undefined
  return `${PREFIX}${specifier.slice(PREFIX.length).split('/')[0]}`
}

function walkDeclarations(dir, visit) {
  if (!existsSync(dir)) return
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) {
      walkDeclarations(path, visit)
      continue
    }
    if (entry.name.endsWith('.d.ts')) visit(path)
  }
}

/**
 * Copy a declaration tree recursively. Only `.d.ts`: the engine's emitted `.js` is inlined into the
 * bundles, and shipping loose engine JavaScript would be packaging the engine twice. The
 * `sourceMappingURL` comment is dropped because the map it names is not carried (a dangling comment
 * in a declaration is noise, and `mission/scripts/build.mjs` drops it the same way).
 */
function copyDeclarations(from, to) {
  let copied = 0
  mkdirSync(to, { recursive: true })
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const source = join(from, entry.name)
    const destination = join(to, entry.name)
    if (entry.isDirectory()) {
      copied += copyDeclarations(source, destination)
      continue
    }
    if (!entry.name.endsWith('.d.ts')) continue
    const text = readFileSync(source, 'utf8').replace(/\n?\/\/# sourceMappingURL=\S*\s*$/u, '\n')
    writeFileSync(destination, text)
    copied += 1
  }
  return copied
}

/** The relative specifier (NodeNext: `.js`, so TS reads the sibling `.d.ts`) for one engine import. */
function relativeSpecifier(file, specifier) {
  const name = packageOf(specifier)
  const engine = name === undefined ? undefined : available.get(name)
  if (engine === undefined) return undefined
  const rest = specifier.slice(name.length).replace(/^\//u, '')
  const base = join(engine.destination, rest.length > 0 ? rest : 'index')
  const path = relative(dirname(file), base).split(sep).join('/')
  return `${path.startsWith('.') ? path : `./${path}`}.js`
}

/** Rewrite `from '@avantf/…'` and `import('@avantf/…')`; a published peer is left alone. */
function repoint(file) {
  const before = readFileSync(file, 'utf8')
  const after = before
    .replace(/(\bfrom\s+)(['"])@avantf\/([^'"]+)\2/gu, (whole, prefix, quote, specifier) => {
      const replaced = relativeSpecifier(file, `${PREFIX}${specifier}`)
      return replaced === undefined ? whole : `${prefix}${quote}${replaced}${quote}`
    })
    .replace(/(\bimport\(\s*)(['"])@avantf\/([^'"]+)\2(\s*\))/gu, (whole, prefix, quote, specifier, suffix) => {
      const replaced = relativeSpecifier(file, `${PREFIX}${specifier}`)
      return replaced === undefined ? whole : `${prefix}${quote}${replaced}${quote}${suffix}`
    })
  if (after === before) return false
  writeFileSync(file, after)
  return true
}

// Rebuilt from scratch: `tsc` never cleans its outDir, so a renamed/removed declaration would
// otherwise stay under lib/engine and ship forever.
rmSync(engineRoot, { recursive: true, force: true })

// ── the declaration closure of lib/types ─────────────────────────────────────────────────────────
const needed = new Set()
const queue = []
const consider = (specifier) => {
  const name = packageOf(specifier)
  if (name === undefined || name === FRAMEWORK_PEER || !available.has(name) || needed.has(name)) return
  needed.add(name)
  queue.push(name)
}
walkDeclarations(pluginTypes, (file) => {
  for (const specifier of importSpecifiers(readFileSync(file, 'utf8'))) consider(specifier)
})
let copied = 0
while (queue.length > 0) {
  const name = queue.shift()
  const engine = available.get(name)
  copied += copyDeclarations(engine.source, engine.destination)
  walkDeclarations(engine.destination, (file) => {
    for (const specifier of importSpecifiers(readFileSync(file, 'utf8'))) consider(specifier)
  })
}
if (needed.size === 0) {
  console.error('carry-engine-types: the plugin declarations reference no engine package — the plugin does not need this step, or it ran before `tsc`')
  process.exit(1)
}

let rewritten = 0
for (const dir of [pluginTypes, engineRoot]) {
  walkDeclarations(dir, (file) => {
    if (repoint(file)) rewritten += 1
  })
}

// Fail closed: the only `@avantf/*` specifier allowed in the shipped declarations after repointing is
// the required, published base peer. `pack-plugin.mjs` asserts the same thing on the tarball's bytes,
// but this runs in the ordinary build so a regression is caught before packing.
const remaining = []
for (const dir of [pluginTypes, engineRoot]) {
  walkDeclarations(dir, (file) => {
    for (const specifier of importSpecifiers(readFileSync(file, 'utf8'))) {
      const name = packageOf(specifier)
      if (name !== undefined && name !== FRAMEWORK_PEER) remaining.push(`${relative(pluginDir, file)} → ${specifier}`)
    }
  })
}
if (remaining.length > 0) {
  console.error(`carry-engine-types: ${String(remaining.length)} declaration specifier(s) still name an unpublished @avantf/* package:`)
  for (const problem of remaining.slice(0, 10)) console.error(`  - ${problem}`)
  process.exit(1)
}

console.log(`carry-engine-types: ok — ${String(copied)} declaration file(s) → lib/engine (${[...needed].join(', ')}), ${String(rewritten)} repointed`)
