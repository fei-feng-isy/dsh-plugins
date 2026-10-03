#!/usr/bin/env node
/**
 * Real-Cordis mount smoke for `@avantf/dsh-mission`: loads the plugin in an actual
 * `@deepseek-ai/cordis` Context and asserts what a mount can prove without a model — service
 * publication, tool registration, storage round-trip, and the pre-step gate.
 *
 * Requires the built artifacts (`pnpm build`). `--runtime` resolves peers from the installed dsh
 * (no checkout needed, per `scripts/link-dsh.mjs --runtime`); otherwise a harness checkout is
 * linked and `DSHHARNESS` may override its discovery. The engine's own dispatch is NOT exercised:
 * it needs the subagent runtime, so `subagents` is a recorder and the run asserts dispatch
 * attempts go through it.
 *
 * PACKED-ARTIFACT MODE — `AVANTF_PLUGIN_DIR` (the extracted tarball's package directory) plus
 * `AVANTF_MOUNT_SCRATCH` (a profile the caller already prepared: the extracted package under
 * `node_modules/@avantf/dsh-mission`, the `@deepseek-ai/*` peers and `zod` beside it, and the base
 * peer iff that variant wants it). Both set together; this run then links NOTHING and only drives
 * the mount, so a leaked engine `@avantf/*` import has nothing to resolve — the mount itself is the
 * assertion that the packed package is self-contained. `pack-plugin.mjs --mount` is the caller.
 *
 * TWO PROFILES, chosen by what is installed — both must hold:
 *
 *   - NORMAL: `@avantf/dsh-plugin-base` is installed into the plugin and built. The gate IS that
 *     package (the former `@avantf/dsh-compat` merged into it), so there is no `mission:compat` item,
 *     nothing to download and no managed `~/.avantf/env/compat/**`. A green run pins that the gate
 *     ran from the installed base (`compat: ok`) and that the SHARED prompt layer came from that
 *     same module: the edited `mission-tree-guide.md` is what the registered section returns.
 *   - ABSENT (`AVANTF_COMPAT_ABSENT=1`): the base is deliberately out of reach — the plugin is
 *     loaded from a scratch copy of its own built artifact, with nothing under
 *     `scratch/node_modules/@avantf/dsh-plugin-base`. The inlined bootstrap then WARNs, the gate is
 *     SKIPPED, the shared prompt layer degrades to the plugin's built-in default, and the plugin
 *     must still mount in full. Without the flag a missing base is a hard failure, so an
 *     uninstalled tree can never pass as green.
 */
import { createRequire } from 'node:module'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveHarness } from '../../scripts/lib/harness-path.mjs'

const require = createRequire(import.meta.url)
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/**
 * The plugin package this run loads.
 *
 * Default: the built artifact in the workspace. `AVANTF_PLUGIN_DIR` + `AVANTF_MOUNT_SCRATCH` are
 * the packed-artifact mode `pack-plugin.mjs --mount` uses — see the header. `packagedProfile` is
 * what turns off this smoke's own linking: the caller owns the profile.
 */
const packagedDir = process.env['AVANTF_PLUGIN_DIR']
const preparedScratch = process.env['AVANTF_MOUNT_SCRATCH']
const pluginDir = packagedDir ?? join(repo, 'packages', 'plugin')
const packagedProfile = packagedDir !== undefined && preparedScratch !== undefined

/**
 * The loose ceiling on mount→ready (see the timeline block near the top of the assertions). It is a
 * "did something pathological get pulled into the mount window" tripwire, NOT a performance budget:
 * the smoke's in-memory storage and this machine make absolute milliseconds unrepresentative, so the
 * margin is deliberately enormous.
 */
const MOUNT_READY_BUDGET_MS = 15_000

/** Every harness package the smoke resolves at runtime, plus the workspace core. */
const LINKS = [
  ['cordis', 'vendor/cordis'],
  ['cordis-plugin-timer', 'vendor/timer'],
  ['schemastery', 'vendor/schemastery'],
  ['dsh-tools', 'packages/core/tools'],
  ['dsh-agent', 'packages/core/agent'],
  ['dsh-session', 'packages/core/session'],
  ['dsh-commands', 'packages/interaction/commands'],
  ['dsh-storage', 'packages/storage/storage'],
  ['dsh-storage-domain', 'packages/storage/storage-domain'],
  ['dsh-subagent', 'packages/subagent/subagent'],
  ['dsh-spill', 'packages/spill/spill'],
  ['dsh-session-query', 'packages/session-query/session-query'],
  ['dsh-llm', 'packages/llm/llm'],
  ['dsh-brand', 'packages/util/brand'],
  ['dsh-util-values', 'packages/util/values'],
  ['dsh-system-prompt', 'packages/core/system-prompt'],
]

const scratch = preparedScratch ?? mkdtempSync(join(tmpdir(), 'avantf-mission-mount-'))
/** The caller's scratch is the caller's to remove (it may want the evidence after a failure). */
const ownsScratch = preparedScratch === undefined
const dataHome = join(scratch, 'data')
mkdirSync(join(scratch, 'node_modules', '@deepseek-ai'), { recursive: true })
mkdirSync(join(scratch, 'node_modules', '@avantf'), { recursive: true })
mkdirSync(dataHome, { recursive: true })

// Point the family root (`$AVANTF_HOME`) at the scratch tree so a smoke never touches the real one.
// The base reads its user-editable prompts from `<data home>/prompts` under it.
process.env['AVANTF_HOME'] = dataHome

// ── which profile this run is ─────────────────────────────────────────────────
// The base must be REACHABLE AND BUILT before anything else runs: with the peer missing, the inlined
// bootstrap only warns and the plugin mounts degraded (gate absent), which must never pass as green
// — so refuse, with the fix. `AVANTF_COMPAT_ABSENT=1` is the explicit opt-in to the other profile.
// "Reachable" is resolved the same way the bootstrap resolves it: `createRequire` off the plugin
// entry. In the workspace that is the plugin's own link; in the packed profile it is whatever the
// caller linked into the scratch tree, or nothing.
const entryRequire = createRequire(join(pluginDir, 'lib', 'index.js'))
const baseDir = (() => {
  try {
    return dirname(entryRequire.resolve('@avantf/dsh-plugin-base/package.json'))
  } catch {
    return undefined
  }
})()
const absentRequested = process.env['AVANTF_COMPAT_ABSENT'] === '1'
const baseReady = baseDir !== undefined && existsSync(join(baseDir, 'dist', 'index.js'))
if (!baseReady && !absentRequested) {
  console.error(`mount-smoke: @avantf/dsh-plugin-base is not installed/built for the plugin (${baseDir ?? `unresolved from ${join(pluginDir, 'lib', 'index.js')}`})`)
  console.error('  without it the inlined bootstrap only warns and the plugin mounts degraded (no gate),')
  console.error('  which is not what this smoke verifies. Run: pnpm install && pnpm build:base')
  console.error('  to exercise the documented degrade path instead:')
  console.error('    AVANTF_COMPAT_ABSENT=1 node scripts/mount-smoke.mjs --runtime')
  process.exit(1)
}
if (baseReady && absentRequested) {
  // The flag means "hide the base": the scratch copy (workspace) or the caller's unlinked scratch
  // profile (packed) is what makes that true, so say it out loud rather than letting a bug leave the
  // gate ON while the assertions expect ABSENT.
  console.warn(`mount-smoke: AVANTF_COMPAT_ABSENT=1 — loading from ${packagedProfile ? 'a profile with no base linked' : 'a copy with no base in reach'}`)
}
/** The gate is ON unless this run is the absent profile (where the loaded copy genuinely cannot resolve it). */
const gateOn = !absentRequested

// The guidance text is user-editable, one `.md` in the shared `<data home>/prompts`. It is seeded HERE,
// before the mount, so the normal profile proves the EDITED text is what reaches the model prompt
// (the shared `PromptFiles` reads that directory once, at apply) and that the plugin does not rewrite
// the file; the absent profile proves the degraded path uses the plugin's OWN default instead.
const promptDir = join(dataHome, 'prompts')
mkdirSync(promptDir, { recursive: true })
const editedGuidance = '只讲任务，不讲形状。这是 smoke 预置的自定义提示词。'
writeFileSync(join(promptDir, 'mission-tree-guide.md'), `${editedGuidance}\n`, 'utf8')

/**
 * Where the plugin's `@deepseek-ai/*` imports resolve. `--runtime` uses this repo's
 * `packages/plugin/node_modules`, which `scripts/link-dsh.mjs --runtime` pointed at an installed
 * dsh — the composition a user's profile loads, needing no checkout. Without it a checkout is
 * linked into a scratch tree, and only that branch reads `DSHHARNESS`.
 */
const runtime = process.argv.includes('--runtime')
const harness = runtime || packagedProfile ? undefined : resolveHarness(undefined, 'mount-smoke')

if (packagedProfile) {
  // The caller prepared the profile (extracted tarball, peers, and the base peer iff this variant
  // wants it): link nothing here. A leaked engine `@avantf/*` import must have nothing to resolve —
  // that is what makes the mount a self-containment proof for the packed artifact.
} else if (runtime) {
  const linked = join(pluginDir, 'node_modules', '@deepseek-ai')
  if (!existsSync(linked)) {
    console.error('mount-smoke: --runtime needs `node scripts/link-dsh.mjs --runtime <dshDir>` first')
    process.exit(1)
  }
  // Mirror the installed peer links into the scratch tree as well: an ABSENT-profile run imports the
  // plugin from a scratch COPY, so its `@deepseek-ai/*` and `zod` have to resolve from there — and to
  // the SAME real directories the Context below is built from, or the two halves would hold different
  // module instances (`ctx.tools.register` identity is what the gate probes).
  for (const name of readdirSync(linked)) {
    symlinkSync(join(linked, name), join(scratch, 'node_modules', '@deepseek-ai', name), 'dir')
  }
  symlinkSync(join(pluginDir, 'node_modules', 'zod'), join(scratch, 'node_modules', 'zod'), 'dir')
} else {
  for (const [name, rel] of LINKS) {
    const from = join(harness, rel)
    if (!existsSync(from)) {
      console.error(`mount-smoke: missing harness package ${name} at ${from}`)
      process.exit(1)
    }
    symlinkSync(from, join(scratch, 'node_modules', '@deepseek-ai', name), 'dir')
  }
  // zod comes from this workspace's install so the storage domain and this plugin share one zod
  // identity; it is a per-package dependency, not hoisted to the repo root.
  symlinkSync(join(pluginDir, 'node_modules', 'zod'), join(scratch, 'node_modules', 'zod'), 'dir')
  symlinkSync(join(pluginDir), join(scratch, 'node_modules', '@avantf', 'dsh-mission'), 'dir')
  symlinkSync(join(repo, 'packages', 'core'), join(scratch, 'node_modules', '@avantf', 'mission-core'), 'dir')
}

/**
 * The plugin artifact to load.
 *
 * NORMAL: the built artifact in place, so `@avantf/dsh-plugin-base` resolves from the plugin's own
 * install — the workspace base under test.
 *
 * ABSENT (workspace): a COPY of the same built artifact, one level under the scratch tree where no
 * `@avantf/dsh-plugin-base` exists, which is what makes "the base is missing" true rather than
 * simulated. Nothing is rebuilt: this is the same bytes the normal profile loads. PACKED the caller
 * did that already — the extracted package sits in a scratch profile with no base linked — so it is
 * imported in place.
 */
let pluginEntry = join(pluginDir, 'lib', 'index.js')
if (absentRequested && !packagedProfile) {
  const copy = join(scratch, 'plugin')
  mkdirSync(copy, { recursive: true })
  cpSync(join(pluginDir, 'lib'), join(copy, 'lib'), { recursive: true })
  cpSync(join(pluginDir, 'package.json'), join(copy, 'package.json'))
  pluginEntry = join(copy, 'lib', 'index.js')
}

const cordisRoot = runtime && !packagedProfile
  ? join(pluginDir, 'node_modules', '@deepseek-ai', 'cordis')
  : join(scratch, 'node_modules', '@deepseek-ai', 'cordis')
const { Context } = require(cordisRoot)
const plugin = await import(pluginEntry)

// ── harness stubs ─────────────────────────────────────────────────────────────
// Each stub mirrors the real service surface, so a wrong call shape fails here.

/** Live agents, keyed by session id. The owner is created inside the run. */
const agents = new Map()

/**
 * Tool names the surrounding deployment provides: `tools.get(name, scope)` feeds the plugin's
 * deny-list narrowing, and `tools.restrict()` throws on a name nothing provides, so this stub must
 * answer for the deployment, not just the plugin's own tools.
 */
const DEPLOYED_TOOLS = new Set([
  'send_message',
  'subagent',
  'subagent_fork',
  'create_goal',
  'get_goal',
  'update_goal',
])

const registeredTools = []
const toolsService = {
  register: (definition) => {
    registeredTools.push(definition)
    // Withdraw by identity: a disposer that ignores its argument leaves the gate's throwaway
    // `__dshCompatProbe` counted as a registered tool.
    return () => {
      const index = registeredTools.indexOf(definition)
      if (index >= 0) registeredTools.splice(index, 1)
    }
  },
  get: (toolName) =>
    registeredTools.find((definition) => definition.name === toolName)
    ?? (DEPLOYED_TOOLS.has(toolName) ? { name: toolName } : undefined),
}

const promptSections = []
const promptContexts = []
const systemPromptService = {
  section: (section) => {
    promptSections.push(section)
    return () => undefined
  },
  context: (context) => {
    promptContexts.push(context)
    return () => undefined
  },
  getSectionOrder: () => 2400,
  getContextOrder: () => 120,
}

/** Every dispatched mission unit, in order. */
const dispatches = []
const subagentService = {
  startContinuable: (spec) => {
    dispatches.push(spec)
    return Promise.resolve({ childId: spec.childId, messageId: 'msg-1' })
  },
  interrupt: () => undefined,
  // The real dsh provides `sendMessage` and the gate declares it required; a stub without it would
  // make the gate refuse a host it actually runs on.
  sendMessage: () => Promise.resolve('msg-1'),
}

const commands = []
const commandService = {
  register: (definition) => {
    commands.push(definition)
    return () => undefined
  },
}

/** Minimal storage: the domain layer is real, only the medium is in-memory. */
const units = new Map()
const storageDomainService = {
  open: async (spec) => {
    const key = spec.name
    if (units.has(key)) {
      throw new Error(`domain '${key}' is already open`)
    }
    const records = new Map()
    units.set(key, records)
    return {
      table: () => ({
        get: (id) => records.get(id),
        entries: () => records.entries(),
        put: (id, value) => {
          records.set(id, value)
          return Promise.resolve()
        },
        delete: (id) => Promise.resolve(records.delete(id)),
        get size() {
          return records.size
        },
      }),
      close: () => {
        // Closing frees the name, exactly like the real facility.
        units.delete(key)
        return Promise.resolve()
      },
    }
  },
}

const ctx = new Context()
ctx.provide('tools', toolsService)
ctx.provide('agents', {
  get: (id) => agents.get(id),
})
ctx.provide('subagents', subagentService)
ctx.provide('systemPrompt', systemPromptService)
ctx.provide('storageDomain', storageDomainService)
ctx.provide('commands', commandService)
// The Typert registry: the plugin registers the host face its browser half mounts.
const typertContributions = []
ctx.provide('typert', {
  register: (contribution) => {
    typertContributions.push(contribution)
    return () => undefined
  },
})
// The real context carries `interval` from the timer plugin; the plugin arms a sweep.
ctx.provide('timer', { interval: () => () => undefined })
ctx.mixin('timer', ['interval'])

const preStepListeners = []
const realOn = ctx.on.bind(ctx)
ctx.on = (eventName, listener, options) => {
  if (eventName === 'agent/pre-step') preStepListeners.push(listener)
  return realOn(eventName, listener, options)
}

// ── mount ─────────────────────────────────────────────────────────────────────
/** The engine's wake: a producer-owned plugin source carrying a signal only. */
const wakeMessage = {
  role: 'user',
  id: 'm2',
  content: [],
  source: { kind: 'plugin:avantf-mission' },
}

const ownerReceived = []
const ownerPending = { nextTurn: [], nextStep: [] }
const owner = {
  id: 'owner-session',
  // A top-level session: no delegation origin, no depth.
  session: { header: {} },
  // The loop's inbox surface: the gate drains its own signals and serves a message queued behind one.
  inbox: {
    get nextTurn() {
      return ownerPending.nextTurn
    },
    get nextStep() {
      return ownerPending.nextStep
    },
    remove: (messageId) => {
      for (const list of [ownerPending.nextStep, ownerPending.nextTurn]) {
        const index = list.findIndex((entry) => entry.id === messageId)
        if (index >= 0) {
          list.splice(index, 1)
          return true
        }
      }
      return false
    },
  },
  followup: (message) => ownerReceived.push(message),
}
agents.set(owner.id, owner)

// One worker slot: the second tree's root stays `ready` instead of being dispatched, keeping the
// wake assertions below independent of core count. stderr is tapped because the gate's verdict
// exists only as a `console.error` line, turning "the gate ran" into an assertion.
const stderr = []
const realConsoleError = console.error.bind(console)
// The mount timeline: the FIRST plugin log to the moment storage is open and the host is ready. It
// exists to back the one loose assertion at the end — "mounting did not become obviously slow" —
// and each run prints it, so a drift is visible long before it trips.
const mountStartedAt = Date.now()
let firstLogAt
console.error = (...args) => {
  const line = args.map(String).join(' ')
  stderr.push(line)
  if (firstLogAt === undefined && line.includes('[avantf-mission]')) firstLogAt = Date.now()
  realConsoleError(...args)
}
await ctx.plugin({ name: plugin.name, inject: plugin.inject, apply: plugin.apply }, { maxConcurrent: 1 })
const host = ctx.get('avantfMission')
// The gate REFUSES a proven-incompatible host and registers nothing, so `host` is undefined; say
// what happened instead of failing later as a property write on undefined.
if (host === undefined) {
  console.error('mount-smoke: the plugin did not mount — nothing was registered.')
  console.error('  the compatibility gate refuses a host it can PROVE incompatible; the `compat:` lines above name it.')
  console.error(stderr.join('\n'))
  process.exit(1)
}
const trace = []
host.onDispatchTrace = (message) => trace.push(message)
await host.start()

const failures = []
const check = (label, condition, detail) => {
  if (condition) {
    console.log(`  ok   ${label}`)
    return
  }
  failures.push(`${label}${detail === undefined ? '' : `: ${detail}`}`)
  console.log(`  FAIL ${label}${detail === undefined ? '' : `: ${detail}`}`)
}

console.log(`avantf-mission mount smoke (${runtime ? 'installed dsh' : 'harness checkout'}${gateOn ? '' : ', base ABSENT'})`)

// ── the mount timeline, and the one thing it is allowed to assert ─────────────
// The threshold is deliberately LOOSE. Per the repo's "a gate must prove one thing" rule, this proves
// only that mounting did not become OBVIOUSLY slow (a full-corpus synchronous scan or a 1.2 s parse
// pulled back into the window would blow past it); it is not a latency budget, and the smoke's in-memory storage
// makes absolute milliseconds unrepresentative, so a tight number would be a false-alarm generator.
// The measured value is printed on every run regardless, which is where a drift shows up first.
{
  const hostReadyAt = Date.now()
  const mountReadyMs = hostReadyAt - mountStartedAt
  const firstLogMs = firstLogAt === undefined ? undefined : hostReadyAt - firstLogAt
  console.log(`  timeline: mount→ready ${String(mountReadyMs)} ms`
    + `${firstLogMs === undefined ? '' : `（首条插件日志→ready ${String(firstLogMs)} ms）`}`)
  check(
    `mount is not obviously slow (< ${String(MOUNT_READY_BUDGET_MS)} ms; loose by design)`,
    mountReadyMs < MOUNT_READY_BUDGET_MS,
    `${String(mountReadyMs)} ms`,
  )
}

// Assert which side of the gate this run exercised: a silent fallback to the ABSENT path would make
// every assertion below pass for the wrong reason. In the normal profile the gate IS the installed
// base, so `compat: ok` here means "the base loaded, probed the real host face and approved it".
const gateLines = stderr.join('\n')
check(
  gateOn
    ? 'the compatibility gate is ON — the installed base ran and reports ok'
    : 'the base is out of reach: the gate is ABSENT, as documented',
  gateOn
    ? gateLines.includes('compat: ok') && !gateLines.includes('gate is ABSENT')
    : gateLines.includes('the dsh compatibility gate is ABSENT'),
  gateLines.split('\n').filter((line) => line.includes('compat:') || line.includes('ABSENT')).join(' | '),
)
// The shared logic must come from the BASE, not from a copy inlined in this artifact. The prompt
// layer is the observable half: with the base loaded, the file the smoke seeded is what the section
// returns (base's `PromptFiles`); in the absent profile the plugin falls back to its OWN default.
{
  const guide = promptSections.find((section) => section.name === 'avantf:mission-tree-guide')
  const text = guide?.text({ agent: owner })
  check(
    gateOn
      ? 'the shared prompt layer came from the base: the EDITED file is what the section returns'
      : 'without the base the section falls back to the plugin\'s own built-in default',
    gateOn
      ? text === editedGuidance
      : text !== editedGuidance && typeof text === 'string' && text.length > 0
        && gateLines.includes('mission-tree-guide.md:default'),
    JSON.stringify(text?.slice(0, 60)),
  )
}

check('service published', ctx.get('avantfMission') !== undefined)
// The service is Remote-capable: the browser half reaches `snapshot` over the Typert gateway.
check('service exposes the Remote snapshot method', typeof ctx.get('avantfMission')?.snapshot === 'function')
check('nine tools registered', registeredTools.length === 9, `got ${String(registeredTools.length)}`)
check(
  'the correction tool is among them, and voiding is NOT a model tool',
  registeredTools.some((tool) => tool.name === 'adjust_mission')
    && !registeredTools.some((tool) => tool.name === 'cancel_subworks'),
  registeredTools.map((tool) => tool.name).join(', '),
)
check(
  'note_mission is registered for the executor half',
  registeredTools.some((tool) => tool.name === 'note_mission'),
  registeredTools.map((tool) => tool.name).join(', '),
)
check('guidance context registered', promptContexts.some((c) => c.name === 'avantf:mission-tree'))
const workCommand = commands.find((command) => command.name === 'mission')
check('/mission command registered', workCommand !== undefined)
check(
  'browser half\'s wire face registered',
  typertContributions.length === 1 && typertContributions[0]?.package === '@avantf/dsh-mission',
  JSON.stringify(typertContributions.length),
)

const tool = (toolName) => registeredTools.find((definition) => definition.name === toolName)

const recordsOf = () => {
  for (const [, records] of units) return records
  return new Map()
}

// ── /mission, read-only mode ──────────────────────────────────────────────────────
if (workCommand !== undefined) {
  const listed = await workCommand.handler({ agent: owner, rawInput: '', commandId: 'c1', attachments: [], signal: new AbortController().signal })
  check('/mission with no input lists', listed.kind === 'success' && listed.text.includes('本会话没有任务'), listed.text)
}

// ── create_mission round-trip ─────────────────────────────────────────────────────
const created = await tool('create_mission').execute(
  { title: 'Migrate the API', description: 'Move callers to v2', analysis: ['v1 is deprecated'] },
  { agent: owner },
)
check('create_mission accepted', created.ok === true, JSON.stringify(created))
check('root persisted', recordsOf().size === 1, `got ${String(recordsOf().size)}`)
const rootId = created.data?.root_id
check('root id returned', typeof rootId === 'string' && rootId.length > 0)

// The diagnostic trace says whether a pass found no candidate, refused one, or failed to materialize a worker.
if (process.env['SMOKE_DEBUG'] !== undefined) {
  console.log(`  debug: trace=${JSON.stringify(trace)}`)
  console.log(`  debug: summary=${JSON.stringify(host.summary(owner))}`)
}

check('root dispatched', dispatches.length === 1, `got ${String(dispatches.length)}`)
check(
  'worker tool filter denies delegation and messaging',
  Array.isArray(dispatches[0]?.request?.toolFilter?.deny)
    && dispatches[0].request.toolFilter.deny.includes('send_message')
    && dispatches[0].request.toolFilter.deny.includes('subagent'),
)
// The deny list draws on the deployment's tools and this plugin's registrations: a name from neither
// makes `tools.restrict()` throw and kills every dispatch.
const providedTools = new Set([...DEPLOYED_TOOLS, ...registeredTools.map((tool) => tool.name)])
check(
  'worker tool filter only names tools the deployment provides',
  (dispatches[0]?.request?.toolFilter?.deny ?? []).every((name) => providedTools.has(name)),
  JSON.stringify(dispatches[0]?.request?.toolFilter?.deny ?? []),
)
check(
  'worker tool filter denies the owner half of the mission-tree face',
  ['create_mission', 'adjust_mission', 'mission_result', 'list_missions', 'finish_mission', 'cancel_mission']
    .every((name) => (dispatches[0]?.request?.toolFilter?.deny ?? []).includes(name)),
  JSON.stringify(dispatches[0]?.request?.toolFilter?.deny ?? []),
)
check(
  'worker tool filter keeps the executor half',
  ['note_mission', 'decompose_mission', 'submit_mission']
    .every((name) => !(dispatches[0]?.request?.toolFilter?.deny ?? []).includes(name)),
)
check(
  'worker prompt carries the node id',
  typeof dispatches[0]?.request?.prompt?.[0]?.text === 'string'
    && dispatches[0].request.prompt[0].text.includes(rootId),
)

// ── the tree is readable through the owner's tools ────────────────────────────
const listed = await tool('list_missions').execute({}, { agent: owner })
check('list_missions sees the tree', listed.ok === true && listed.summary.includes(rootId), listed.summary)

// The owner's list reports running/stuck, never how the engine distributed mission internally.
check(
  'list_missions stops at running/stuck and reports no per-state breakdown',
  listed.ok === true
    && listed.summary.includes('执行中')
    && !['待执行', '等待子任务', '已完成', '已失败'].some((word) => listed.summary.includes(word)),
  listed.summary,
)

// ── a wake with nothing to act on must be dropped ───────────────────────────
// The only tree's root is `running`, so there is nothing to act on and the turn must not be spent.
// The batch is EMPTIED, never refused: refusal ends the turn.
if (preStepListeners.length === 1) {
  const wakeDecision = await preStepListeners[0](
    { agent: owner, messages: [wakeMessage], turn: 1, step: 1, signal: new AbortController().signal },
    () => Promise.resolve({ kind: 'enter', messages: [wakeMessage] }),
  )
  check(
    'engine wake dropped when nothing is actionable',
    wakeDecision.kind === 'enter' && (wakeDecision.messages?.length ?? 0) === 0,
    JSON.stringify(wakeDecision),
  )
}

// ── the empty batch of a continuing turn must not be refused ─────────────────
// The loop proposes an empty batch at every step boundary after the first; refusing one ends the
// turn before the model reads its own tool result.
if (preStepListeners.length === 1) {
  const emptyDecision = await preStepListeners[0](
    { agent: owner, messages: [], turn: 1, step: 2, signal: new AbortController().signal },
    () => Promise.resolve({ kind: 'enter', messages: [] }),
  )
  check(
    'empty continuation batch enters instead of being refused',
    emptyDecision.kind === 'enter',
    JSON.stringify(emptyDecision),
  )
}

// ── a message queued behind a signal is served, not stranded ─────────────────
// A claim takes ONE next-turn item, so a notice in front of the user's message leaves it pending;
// a step that does not open stops the driver and the message waits for an unrelated wake.
if (preStepListeners.length === 1) {
  const queued = { role: 'user', id: 'm3', content: [], source: { kind: 'user' } }
  ownerPending.nextTurn.push(queued)
  const served = await preStepListeners[0](
    { agent: owner, messages: [wakeMessage], turn: 1, step: 2, signal: new AbortController().signal },
    () => Promise.resolve({ kind: 'enter', messages: [wakeMessage] }),
  )
  check(
    'a message queued behind a signal reaches the step',
    served.kind === 'enter' && served.messages?.some((entry) => entry.id === 'm3') === true,
    JSON.stringify(served),
  )
  check('the served message leaves the inbox', ownerPending.nextTurn.length === 0, JSON.stringify(ownerPending.nextTurn))
}

// ── a second tree in the same process must not re-open the domain ─────────────
const second = await tool('create_mission').execute(
  { title: 'Second tree', description: 'Another unit of mission', analysis: [] },
  { agent: owner },
)
check('second tree created without reopening the domain', second.ok === true, JSON.stringify(second))

// ── finish gate ──────────────────────────────────────────────────────────────
const early = await tool('finish_mission').execute({ root_id: rootId }, { agent: owner })
check('finish refused while the root is unfinished', early.ok === false, JSON.stringify(early))

// ── the pre-step gate ────────────────────────────────────────────────────────
check('pre-step listener registered', preStepListeners.length === 1, `got ${String(preStepListeners.length)}`)

if (preStepListeners.length === 1) {
  const listener = preStepListeners[0]
  // The default the agent loop uses: the claimed inbox batch plus the runtime-context snapshot; a
  // stub returning `messages: []` could not show whether the hook preserves either.
  const user = { role: 'user', id: 'm1', content: [], source: { kind: 'user' } }
  const snapshot = { role: 'user', id: 's1', content: [], source: { kind: 'runtime-context', form: 'snapshot', sections: [{ name: 'avantf-mission', text: 'guidance' }] } }
  const enterWith = (claimed, context) => () =>
    Promise.resolve({ kind: 'enter', messages: context === undefined ? [...claimed] : [...claimed, context] })

  const userDecision = await listener(
    { agent: owner, messages: [user], turn: 1, step: 1, signal: new AbortController().signal },
    enterWith([user], snapshot),
  )
  check('user message admitted', userDecision.kind === 'enter')
  check(
    'runtime-context snapshot survives the gate',
    userDecision.messages?.some((entry) => entry.id === 's1') === true,
    JSON.stringify(userDecision),
  )

  // With mission in hand the same wake must open a turn: the second tree's root is `ready` behind the
  // single worker slot, so this is mission.
  const actionable = { agent: owner, messages: [wakeMessage], turn: 1, step: 1, signal: new AbortController().signal }
  const liveWake = await listener(actionable, enterWith([wakeMessage], snapshot))
  check(
    'engine wake opens a turn when a tree has mission',
    liveWake.kind === 'enter' && (liveWake.messages?.length ?? 0) > 0,
    JSON.stringify(liveWake),
  )
}


// ── /mission, creating mode (runs last: it adds a tree) ───────────────────────────
if (workCommand !== undefined) {
  const rooted = await workCommand.handler({ agent: owner, rawInput: ' Ship the migration ', commandId: 'c2', attachments: [], signal: new AbortController().signal })
  check('/mission with text creates a root', rooted.kind === 'success' && /\[[0-9a-f]+\]/.test(rooted.text), rooted.text)
  // The engine's cap may already be full (maxConcurrent=1), so the new root must be dispatchable or
  // already dispatched — never silently absent.
  const slashRoot = (await host.snapshot({ sessionId: owner.id })).trees
    .map((tree) => tree.nodes.find((node) => node.id === tree.rootId))
    .find((node) => node?.title === 'Ship the migration')
  check(
    'the slash-created root entered the dispatch pool',
    slashRoot !== undefined && (slashRoot.status === 'ready' || slashRoot.status === 'running'),
    JSON.stringify(slashRoot?.status),
  )
  check(
    'the tree is visible to the list mode',
    (await workCommand.handler({ agent: owner, rawInput: '', commandId: 'c3', attachments: [], signal: new AbortController().signal })).text.includes('Ship the migration'),
  )
}

// ── the editable guidance file ────────────────────────────────────────────────
// The section's text was already asserted right after the mount (it is the observable half of "the
// shared layer came from the base"); what remains is that a user's file is never rewritten, and that
// the section's identity still gates the text.
{
  const guide = promptSections.find((section) => section.name === 'avantf:mission-tree-guide')
  check(
    'the seeded guidance file was left alone',
    readFileSync(join(promptDir, 'mission-tree-guide.md'), 'utf8') === `${editedGuidance}\n`,
  )
  check(
    'a session that may not root a mission still gets no guidance',
    guide?.text({ agent: { ...owner, id: 'outsider', header: { origin: 'subagent', delegationDepth: 1 }, session: { header: { origin: 'subagent', delegationDepth: 1 } } } }) === '',
  )
}

// ── teardown ─────────────────────────────────────────────────────────────────
await host.stop()
if (ownsScratch) rmSync(scratch, { recursive: true, force: true })

if (failures.length > 0) {
  console.error(`\nMOUNT SMOKE FAILED (${String(failures.length)})`)
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}
console.log('\nMOUNT SMOKE OK')
