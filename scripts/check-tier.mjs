#!/usr/bin/env node
/**
 * The two closure tiers — the ONE place that decides what "收口" means.
 *
 * WHY TIERS. The pre-2026-10-03 closure ran the same full sequence for every change: each tree's
 * `release:check` (link → build → typecheck → the whole test suite → pack → the old-dsh floor gate)
 * plus a separate `pnpm test`, `build:dsh mem`, `build:dsh mission`, two mount smokes, `guard`, the
 * four self-tests, `prepublish:assert` and the root `release:check`. Everything appeared as many times
 * over, so a one-line copy change cost the same as a release candidate. The tiers split that:
 *
 *   fast     — one tree, once: build + typecheck + that tree's full suite, plus the root-wide cheap
 *              gates (guard, four self-tests, prepublish assertions). NOT old-dsh / pack / mount
 *              smoke / root release:check.
 *   release  — before publishing (or after changing `base/**`, the publish surface, the gate scripts
 *              or a version): every strict per-package gate (pack + old-dsh floor + the plugins'
 *              plugin mount smokes) and the root release surface.
 *
 * DEDUP IS THE POINT. A step appears exactly once in a run: the fast tier does not run a tree's
 * suite twice, and the release tier does not repeat the fast tier first (the strict gates already
 * contain build/typecheck/tests). `base` is built once by the fast tier, before the target tree.
 *
 * USAGE
 *   pnpm check:fast <base|mem|mission|root>   # one named tree
 *   pnpm check:fast                           # auto-detect the changed tree(s) from git
 *   pnpm check:release                        # the release tier (every strict gate + root surface)
 *   pnpm check:release --parallel             # run the strict gates at once (opt-in)
 *
 * PARALLELISM (see `docs/CLOSURE-TIERS.md` for the full analysis). `scripts/check-old-dsh.mjs` is
 * group-isolated BY CONSTRUCTION — it links inside the target tree's own `node_modules`, and its
 * closure cache / fake global root are keyed by `(group, floor)` — so the old-dsh legs do not
 * interfere across trees. What is NOT isolated is `base/plugin-base/dist`: every tree's gate rebuilds
 * the base (`mem` and `mission` build it before their plugin, the base's own gate builds it), and
 * `mem`'s strict gate additionally runs a workspace-wide `pnpm install`. Running the gates
 * concurrently therefore puts several `tsc` writers and one `node_modules` writer on shared state, so
 * the release tier runs them SEQUENTIALLY by default; `--parallel` exists for a machine/CI measured
 * clean (each gate still writes its own log). The fast tier is single-tree by design.
 *
 * @module scripts/check-tier
 */
import { execFileSync, spawn } from 'node:child_process'
import { createWriteStream, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { repoRoot as repo } from './lib/plugins.mjs'
import { spawnToolSync, toolInvocation } from './lib/win-spawn.mjs'

const NODE = process.execPath

/** @typedef {{ label: string, command: string, args: string[], cwd?: string, tree?: string }} Step */

// ── the step tables ───────────────────────────────────────────────────────────────────────────────

/**
 * Build the family base ONCE per fast run.
 *
 * The plugin trees type-check and bundle against `base/plugin-base/dist`, and their own build scripts
 * would rebuild it; this is the single base build the fast tier performs, and the `mem`/`mission`
 * fast steps deliberately call the tree's own build entries (which do not rebuild the base) rather
 * than `build:dsh` (which does).
 */
const baseBuild = { label: 'build base (@avantf/dsh-plugin-base) — the one base build', command: 'pnpm', args: ['-C', 'base/plugin-base', 'build'] }

/**
 * The root-wide cheap gates the fast tier always adds, whichever tree changed.
 *
 * `guard` + the four self-tests + the publish-surface assertions: seconds together, and each is a
 * repo-wide invariant a change in any tree can break.
 */
const rootGates = [
  { label: 'boundary guard (trees stay independent)', command: 'pnpm', args: ['guard'] },
  { label: 'self-test: gate logic', command: NODE, args: ['scripts/gates.test.mjs'] },
  { label: 'self-test: toolchain (cache key, preset drift, guard)', command: NODE, args: ['scripts/toolchain.test.mjs'] },
  { label: 'self-test: dsh-line coverage', command: NODE, args: ['scripts/check-dsh-lines.test.mjs'] },
  { label: 'self-test: version tool', command: NODE, args: ['scripts/version.test.mjs'] },
  { label: 'prepublish assertions (publish surface)', command: NODE, args: ['scripts/prepublish-assert.mjs'] },
]

/**
 * FAST steps per tree. Each list mirrors what that tree's `release:check` proves about build /
 * typecheck / tests, with the release-only legs removed (pack, old-dsh, mount smoke) and the base
 * hoisted out. `root` is the tree-less target (only the root-wide gates, for a change that touched
 * none of the plugin trees).
 */
const FAST = {
  base: [
    { label: 'build base', command: 'pnpm', args: ['-C', 'base/plugin-base', 'build'] },
    { label: 'typecheck base (src + tests)', command: 'pnpm', args: ['-C', 'base/plugin-base', 'typecheck'] },
    { label: 'test base (full suite, once)', command: 'pnpm', args: ['-C', 'base/plugin-base', 'test'] },
  ],
  mem: [
    baseBuild,
    { label: 'build mem engine packages', command: 'pnpm', args: ['-C', 'mem', 'build'] },
    { label: 'typecheck mem engine packages', command: 'pnpm', args: ['-C', 'mem', 'typecheck'] },
    // The plugin's own `build` entry is tsc+tsdown WITHOUT the mount smoke that `build:dsh` adds.
    // Its peer specs (which need the linked dsh) run explicitly below — otherwise they only ever run
    // inside `build:dsh`.
    { label: 'build mem plugin (no mount smoke)', command: 'pnpm', args: ['-C', 'mem/packages/plugin', 'build'] },
    // The post-build artifact gates `build:dsh` would run: bootstrap actually inlined / base still
    // external, and `lib/client.js` path-independent. Seconds, and both judge the bytes just built.
    { label: 'assert the base inlining (envinit artifacts)', command: NODE, args: ['mem/scripts/assert-envinit-artifacts.mjs'] },
    { label: 'assert the client artifact is path-independent', command: NODE, args: ['mem/scripts/assert-client-portable.mjs'] },
    { label: 'typecheck mem plugin (LOCAL: the installed dsh)', command: 'pnpm', args: ['-C', 'mem', 'typecheck:dsh'] },
    { label: 'test mem (engine + plugin suites, once)', command: 'pnpm', args: ['-C', 'mem', 'test'] },
    { label: 'test mem plugin peers (LOCAL: the installed dsh)', command: 'pnpm', args: ['-C', 'mem/packages/plugin', 'test:dsh'] },
  ],
  mission: [
    baseBuild,
    { label: 'typecheck mission (src + tests)', command: 'pnpm', args: ['-C', 'mission', 'typecheck'] },
    { label: 'link mission DSH peers (LOCAL: the installed dsh)', command: NODE, args: ['mission/scripts/link-dsh.mjs', '--runtime'] },
    { label: 'vendor the base bootstrap', command: NODE, args: ['mission/scripts/link-envinit.mjs'] },
    { label: 'build mission (core + plugin, no mount smoke)', command: 'pnpm', args: ['-C', 'mission', 'build'] },
    { label: 'bundle mission client half', command: NODE, args: ['mission/scripts/build-client.mjs'] },
    // The built browser half must self-register / export the client plugin shape; `release:check` runs
    // this between the tests and pack, but it judges the just-built artifact, so it belongs here too.
    { label: 'client smoke (built browser half)', command: NODE, args: ['mission/scripts/client-smoke.mjs'] },
    { label: 'test mission (core + plugin suites, once)', command: 'pnpm', args: ['-C', 'mission', 'test'] },
  ],
  identity: [
    baseBuild,
    { label: 'typecheck identity (src + tests)', command: 'pnpm', args: ['-C', 'identity', 'typecheck'] },
    { label: 'link identity DSH peers (LOCAL: the installed dsh)', command: NODE, args: ['identity/scripts/link-dsh.mjs', '--runtime'] },
    { label: 'vendor the base bootstrap', command: NODE, args: ['identity/scripts/link-envinit.mjs'] },
    { label: 'build identity (plugin, no mount smoke)', command: 'pnpm', args: ['-C', 'identity', 'build'] },
    { label: 'bundle identity client half', command: NODE, args: ['identity/scripts/build-client.mjs'] },
    // The built browser half must self-register / export the client plugin shape; `release:check` runs
    // this between the tests and pack, but it judges the just-built artifact, so it belongs here too.
    { label: 'client smoke (built browser half)', command: NODE, args: ['identity/scripts/client-smoke.mjs'] },
    { label: 'test identity (plugin suite, once)', command: 'pnpm', args: ['-C', 'identity', 'test'] },
  ],
  root: [],
}

/**
 * The RELEASE steps. Each is that package's own strict gate (`release:check`), which already contains
 * pack and the old-dsh floor gate; the plugins' also contain their real-Cordis mount smoke.
 */
const RELEASE = [
  { label: 'strict gate: base (@avantf/dsh-plugin-base)', command: 'pnpm', args: ['-C', 'base/plugin-base', 'release:check'], tree: 'base' },
  { label: 'strict gate: mem (@avantf/dsh-mem, incl. mount smoke)', command: 'pnpm', args: ['-C', 'mem', 'release:check'], tree: 'mem' },
  { label: 'strict gate: mission (@avantf/dsh-mission, incl. mount smoke)', command: 'pnpm', args: ['-C', 'mission', 'release:check'], tree: 'mission' },
  { label: 'strict gate: identity (@avantf/dsh-identity, incl. mount smoke)', command: 'pnpm', args: ['-C', 'identity', 'release:check'], tree: 'identity' },
]

/** The root surface runs last and serially: it judges the manifests the gates just packed. */
const ROOT_RELEASE = { label: 'release surface (publishable set, peers, one zod, published base)', command: 'pnpm', args: ['release:check'] }

/** The publish-time assertions (version stamped, READMEs ship, no release tooling in a tarball). Cheap. */
const RELEASE_ASSERT = { label: 'prepublish assertions (publish surface)', command: NODE, args: ['scripts/prepublish-assert.mjs'] }

// ── plumbing ──────────────────────────────────────────────────────────────────────────────────────

const USAGE = `usage:
  pnpm check:fast <base|mem|mission|identity|root>   # fast tier for one tree (or 'root' for the repo-wide gates)
  pnpm check:fast                           # auto-detect the changed tree(s) from git
  pnpm check:release                        # release tier: every strict gate + the root surface
  pnpm check:release --parallel             # run the strict gates at once (opt-in: shared base/ + install)
  pnpm check:release --serial               # run the strict gates one at a time (the default)`

function fail(message) {
  console.error(`check-tier: ${message}`)
  console.error(USAGE)
  process.exit(2)
}

/** Run one step to completion, inheriting stdio. Returns true on success. */
function runStep(step) {
  console.log(`\n▶ ${step.label}`)
  const result = spawnToolSync(step.command, step.args, { cwd: step.cwd ?? repo, stdio: 'inherit', env: process.env })
  if (result.error) {
    console.error(`  cannot run ${step.command}: ${result.error.message}`)
    return false
  }
  if (result.status !== 0) {
    console.error(`  FAILED: ${step.label} (exit ${String(result.status)})`)
    return false
  }
  return true
}

/** Run a list serially, fail-fast. Returns the failing label, or undefined when all passed. */
function runSerial(steps) {
  for (const step of steps) if (!runStep(step)) return step.label
  return undefined
}

/**
 * Run one step as an async job, its combined output written to `logPath`. Resolves `{ ok, code }`.
 *
 * Used by the release tier's per-tree gates: a gate is minutes long and its log has to be
 * attributable, so it goes to its own file instead of interleaving on one stream.
 */
function runLogged(step, logPath) {
  return new Promise((resolve) => {
    const out = createWriteStream(logPath)
    console.log(`▶ ${step.label}\n  log: ${logPath}`)
    const invocation = toolInvocation(process.platform, step.command, step.args)
    const child = spawn(invocation.command, invocation.args, {
      cwd: step.cwd ?? repo,
      shell: invocation.shell,
      env: process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    child.stdout.on('data', (chunk) => out.write(chunk))
    child.stderr.on('data', (chunk) => out.write(chunk))
    child.on('error', (error) => {
      out.write(`\ncannot run ${step.command}: ${error.message}\n`)
      out.end(() => resolve({ ok: false, code: null }))
    })
    child.on('close', (code) => out.end(() => resolve({ ok: code === 0, code })))
  })
}

/** The last `count` lines of a log, for a failure report. */
function tail(logPath, count = 30) {
  try {
    const lines = readFileSync(logPath, 'utf8').trimEnd().split('\n')
    return lines.slice(-count).join('\n')
  } catch {
    return '(no log)'
  }
}

// ── target detection ──────────────────────────────────────────────────────────────────────────────

/**
 * The trees a git-visible change touches, derived from `git status --porcelain`.
 *
 * Only the leading path segment is read; a change that touches no tree selects
 * `root`. Deliberately a convenience, not a gate: a working tree with unrelated uncommitted edits
 * over-selects, so a caller who knows the change names the tree explicitly.
 */
function detectTargets() {
  let status
  try {
    status = execFileSync('git', ['status', '--porcelain', '--untracked-files=all'], { cwd: repo, encoding: 'utf8' })
  } catch {
    return []
  }
  const trees = new Set()
  let rootTouched = false
  for (const line of status.split('\n')) {
    if (line.trim() === '') continue
    // `XY <path>`; a rename shows `old -> new`, and both sides count.
    for (const raw of line.slice(3).split(' -> ')) {
      const path = raw.replace(/^"|"$/gu, '')
      const segment = path.split('/')[0]
      if (segment === 'base' || segment === 'mem' || segment === 'mission' || segment === 'identity') trees.add(segment)
      else rootTouched = true
    }
  }
  if (trees.size === 0) return rootTouched ? ['root'] : []
  return [...trees]
}

// ── the tiers ─────────────────────────────────────────────────────────────────────────────────────

function fast(argv) {
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE)
    return
  }
  const unknown = argv.filter((arg) => arg.startsWith('-'))
  if (unknown.length > 0) fail(`unknown option ${unknown.join(', ')}`)
  let targets = argv.filter((arg) => !arg.startsWith('-'))
  if (targets.length === 0) {
    targets = detectTargets()
    if (targets.length === 0) fail('no changed tree detected — name one: base | mem | mission | identity | root')
    console.log(`check:fast — no tree named; git says: ${targets.join(', ')}`)
  }
  for (const target of targets) {
    if (!Object.hasOwn(FAST, target)) fail(`unknown tree '${target}' (expected base | mem | mission | identity | root)`)
  }
  const steps = []
  // The base is built once: the `base` target has its own build step, and any other target's hoisted
  // `baseBuild` is dropped when the base is already targeted or was already added.
  const baseTargeted = targets.includes('base')
  let baseAdded = false
  for (const target of targets) {
    for (const step of FAST[target]) {
      if (step === baseBuild) {
        if (baseAdded || baseTargeted) continue
        baseAdded = true
      }
      steps.push(step)
    }
  }
  steps.push(...rootGates)

  console.log(`check:fast — ${targets.join(', ')} (${String(steps.length)} steps)`)
  const failed = runSerial(steps)
  if (failed !== undefined) {
    console.error(`\ncheck:fast FAILED at: ${failed}`)
    process.exit(1)
  }
  console.log(`\ncheck:fast ok (${targets.join(', ')})`)
}

async function release(argv) {
  const parallel = argv.includes('--parallel')
  const serial = argv.includes('--serial')
  const unknown = argv.filter((arg) => !['--parallel', '--serial', '--help', '-h'].includes(arg))
  if (unknown.length > 0) fail(`unknown option ${unknown.join(', ')}`)
  if (parallel && serial) fail('--parallel and --serial are mutually exclusive')
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(USAGE)
    return
  }

  const logsDir = join(repo, 'logs')
  mkdirSync(logsDir, { recursive: true })
  const results = []

  if (parallel) {
    console.log('check:release — strict gates in PARALLEL (opt-in; each writes its own log)')
    const jobs = RELEASE.map((step) => {
      const logPath = join(logsDir, `check-release-${step.tree}.log`)
      return runLogged(step, logPath).then(({ ok, code }) => ({ step, ok, code, logPath }))
    })
    for (const job of await Promise.all(jobs)) results.push([job.step, job.ok, job.code, job.logPath])
  } else {
    for (const step of RELEASE) {
      const logPath = join(logsDir, `check-release-${step.tree}.log`)
      const { ok, code } = await runLogged(step, logPath)
      results.push([step, ok, code, logPath])
    }
  }

  const rootOk = runStep(ROOT_RELEASE)
  results.push([ROOT_RELEASE, rootOk, rootOk ? 0 : 1, undefined])
  const assertOk = runStep(RELEASE_ASSERT)
  results.push([RELEASE_ASSERT, assertOk, assertOk ? 0 : 1, undefined])

  console.log('\n──────── check:release summary ────────')
  let failed = false
  for (const [step, ok, code, logPath] of results) {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${step.label}${code === null || code === undefined ? '' : ` (exit ${String(code)})`}`)
    if (!ok) {
      failed = true
      if (logPath !== undefined) {
        console.error(`\n── last lines of ${logPath} ──`)
        console.error(tail(logPath))
      }
    }
  }
  if (failed) {
    console.error(`\ncheck:release FAILED — per-tree logs in ${logsDir}`)
    process.exit(1)
  }
  console.log('\ncheck:release ok')
}

// ── entry ─────────────────────────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2)
const mode = argv[0]
if (mode === '--help' || mode === '-h') {
  console.log(USAGE)
} else if (mode === 'fast') {
  fast(argv.slice(1))
} else if (mode === 'release') {
  await release(argv.slice(1))
} else {
  fail(mode === undefined ? 'pass a tier: fast | release' : `unknown tier '${mode}' (expected fast | release)`)
}
