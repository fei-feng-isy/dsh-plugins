#!/usr/bin/env node
/**
 * Real-Cordis mount smoke for `@avantf/dsh-work`: loads the plugin in an actual
 * `@deepseek-ai/cordis` Context and asserts what a mount can prove without a model — service
 * publication, tool registration, storage round-trip, and the pre-step gate.
 *
 * Requires the built artifacts (`pnpm build`). `--runtime` resolves peers from the installed dsh
 * (no checkout needed, per `scripts/link-dsh.mjs --runtime`); otherwise a harness checkout is
 * linked and `DSHHARNESS` may override its discovery. The engine's own dispatch is NOT exercised:
 * it needs the subagent runtime, so `subagents` is a recorder and the run asserts dispatch
 * attempts go through it.
 *
 * TWO PROFILES, chosen by what is installed — both must hold:
 *
 *   - NORMAL: `@avantf/dsh-plugin-base` is installed into the plugin and built. The gate IS that
 *     package (the former `@avantf/dsh-compat` merged into it), so there is no `work:compat` item,
 *     nothing to download and no managed `~/.avantf/env/compat/**`. A green run pins that the gate
 *     ran from the installed base (`compat: ok`) and that the SHARED prompt layer came from that
 *     same module: the edited `work-tree-guide.md` is what the registered section returns.
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
const pluginDir = join(repo, 'packages', 'plugin')

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

const scratch = mkdtempSync(join(tmpdir(), 'avantf-work-mount-'))
const dataHome = join(scratch, 'data')
mkdirSync(join(scratch, 'node_modules', '@deepseek-ai'), { recursive: true })
mkdirSync(join(scratch, 'node_modules', '@avantf'), { recursive: true })
mkdirSync(dataHome, { recursive: true })

// Point the family root (`$AVANTF_HOME`) at the scratch tree so a smoke never touches the real one.
// The base reads its user-editable prompts from `<data home>/prompts` under it.
process.env['AVANTF_HOME'] = dataHome

// ── which profile this run is ─────────────────────────────────────────────────
// The base must be INSTALLED and BUILT before anything else runs: with the peer missing, the
// inlined bootstrap only warns and the plugin mounts degraded (gate absent), which must never pass
// as green — so refuse, with the fix. `AVANTF_COMPAT_ABSENT=1` is the explicit opt-in to the other
// profile, and it is the only way to get the degraded path instead of a hard failure.
const baseDir = join(pluginDir, 'node_modules', '@avantf', 'dsh-plugin-base')
const baseManifest = join(baseDir, 'package.json')
const absentRequested = process.env['AVANTF_COMPAT_ABSENT'] === '1'
const baseReady = existsSync(baseManifest) && existsSync(join(baseDir, 'dist', 'index.js'))
if (!baseReady && !absentRequested) {
  console.error(`mount-smoke: @avantf/dsh-plugin-base is not installed/built for the plugin (${baseManifest})`)
  console.error('  without it the inlined bootstrap only warns and the plugin mounts degraded (no gate),')
  console.error('  which is not what this smoke verifies. Run: pnpm install && pnpm build:base')
  console.error('  to exercise the documented degrade path instead:')
  console.error('    AVANTF_COMPAT_ABSENT=1 node scripts/mount-smoke.mjs --runtime')
  process.exit(1)
}
if (baseReady && absentRequested) {
  // The flag means "hide the base": the scratch copy below is what makes that true, so say it out
  // loud rather than letting a bug leave the gate ON while the assertions expect ABSENT.
  console.warn('mount-smoke: AVANTF_COMPAT_ABSENT=1 — the plugin is loaded from a copy with no base in reach')
}
/** The gate is ON unless this run is the absent profile (where the copy genuinely cannot resolve it). */
const gateOn = !absentRequested

// The guidance text is user-editable, one `.md` in the shared `<data home>/prompts`. It is seeded HERE,
// before the mount, so the normal profile proves the EDITED text is what reaches the model prompt
// (the shared `PromptFiles` reads that directory once, at apply) and that the plugin does not rewrite
// the file; the absent profile proves the degraded path uses the plugin's OWN default instead.
const promptDir = join(dataHome, 'prompts')
mkdirSync(promptDir, { recursive: true })
const editedGuidance = '只讲工作，不讲形状。这是 smoke 预置的自定义提示词。'
writeFileSync(join(promptDir, 'work-tree-guide.md'), `${editedGuidance}\n`, 'utf8')

/**
 * Where the plugin's `@deepseek-ai/*` imports resolve. `--runtime` uses this repo's
 * `packages/plugin/node_modules`, which `scripts/link-dsh.mjs --runtime` pointed at an installed
 * dsh — the composition a user's profile loads, needing no checkout. Without it a checkout is
 * linked into a scratch tree, and only that branch reads `DSHHARNESS`.
 */
const runtime = process.argv.includes('--runtime')
const harness = runtime ? undefined : resolveHarness(undefined, 'mount-smoke')

if (runtime) {
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
  symlinkSync(join(pluginDir), join(scratch, 'node_modules', '@avantf', 'dsh-work'), 'dir')
  symlinkSync(join(repo, 'packages', 'core'), join(scratch, 'node_modules', '@avantf', 'work-core'), 'dir')
}

/**
 * The plugin artifact to load.
 *
 * NORMAL: the built artifact in place, so `@avantf/dsh-plugin-base` resolves from the plugin's own
 * install — the workspace base under test.
 *
 * ABSENT: a COPY of the same built artifact, one level under the scratch tree where no
 * `@avantf/dsh-plugin-base` exists, which is what makes "the base is missing" true rather than
 * simulated. Nothing is rebuilt: this is the same bytes the normal profile loads.
 */
let pluginEntry = join(pluginDir, 'lib', 'index.js')
if (absentRequested) {
  const copy = join(scratch, 'plugin')
  mkdirSync(copy, { recursive: true })
  cpSync(join(pluginDir, 'lib'), join(copy, 'lib'), { recursive: true })
  cpSync(join(pluginDir, 'package.json'), join(copy, 'package.json'))
  pluginEntry = join(copy, 'lib', 'index.js')
}

const cordisRoot = runtime
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

/** Every dispatched work unit, in order. */
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
/** The engine's wake: a plugin-sourced message carrying a signal only. */
const wakeMessage = {
  role: 'user',
  id: 'm2',
  content: [],
  source: { kind: 'plugin', plugin: 'avantf-work' },
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
console.error = (...args) => { stderr.push(args.map(String).join(' ')); realConsoleError(...args) }
await ctx.plugin({ name: plugin.name, inject: plugin.inject, apply: plugin.apply }, { maxConcurrent: 1 })
const host = ctx.get('avantfWork')
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

console.log(`avantf-work mount smoke (${runtime ? 'installed dsh' : 'harness checkout'}${gateOn ? '' : ', base ABSENT'})`)

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
  const guide = promptSections.find((section) => section.name === 'avantf:work-tree-guide')
  const text = guide?.text({ agent: owner })
  check(
    gateOn
      ? 'the shared prompt layer came from the base: the EDITED file is what the section returns'
      : 'without the base the section falls back to the plugin\'s own built-in default',
    gateOn
      ? text === editedGuidance
      : text !== editedGuidance && typeof text === 'string' && text.length > 0
        && gateLines.includes('work-tree-guide.md:default'),
    JSON.stringify(text?.slice(0, 60)),
  )
}

check('service published', ctx.get('avantfWork') !== undefined)
// The service is Remote-capable: the browser half reaches `snapshot` over the Typert gateway.
check('service exposes the Remote snapshot method', typeof ctx.get('avantfWork')?.snapshot === 'function')
check('nine tools registered', registeredTools.length === 9, `got ${String(registeredTools.length)}`)
check(
  'the correction tool is among them, and voiding is NOT a model tool',
  registeredTools.some((tool) => tool.name === 'adjust_work')
    && !registeredTools.some((tool) => tool.name === 'cancel_subworks'),
  registeredTools.map((tool) => tool.name).join(', '),
)
check(
  'note_work is registered for the executor half',
  registeredTools.some((tool) => tool.name === 'note_work'),
  registeredTools.map((tool) => tool.name).join(', '),
)
check('guidance context registered', promptContexts.some((c) => c.name === 'avantf:work-tree'))
const workCommand = commands.find((command) => command.name === 'work')
check('/work command registered', workCommand !== undefined)
check(
  'browser half\'s wire face registered',
  typertContributions.length === 1 && typertContributions[0]?.package === '@avantf/dsh-work',
  JSON.stringify(typertContributions.length),
)

const tool = (toolName) => registeredTools.find((definition) => definition.name === toolName)

const recordsOf = () => {
  for (const [, records] of units) return records
  return new Map()
}

// ── /work, read-only mode ──────────────────────────────────────────────────────
if (workCommand !== undefined) {
  const listed = await workCommand.handler({ agent: owner, rawInput: '', commandId: 'c1', attachments: [], signal: new AbortController().signal })
  check('/work with no input lists', listed.kind === 'success' && listed.text.includes('本会话没有工作'), listed.text)
}

// ── create_work round-trip ─────────────────────────────────────────────────────
const created = await tool('create_work').execute(
  { title: 'Migrate the API', description: 'Move callers to v2', analysis: ['v1 is deprecated'] },
  { agent: owner },
)
check('create_work accepted', created.ok === true, JSON.stringify(created))
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
  'worker tool filter denies the owner half of the work-tree face',
  ['create_work', 'adjust_work', 'work_result', 'list_works', 'finish_work', 'cancel_work']
    .every((name) => (dispatches[0]?.request?.toolFilter?.deny ?? []).includes(name)),
  JSON.stringify(dispatches[0]?.request?.toolFilter?.deny ?? []),
)
check(
  'worker tool filter keeps the executor half',
  ['note_work', 'decompose_work', 'submit_work']
    .every((name) => !(dispatches[0]?.request?.toolFilter?.deny ?? []).includes(name)),
)
check(
  'worker prompt carries the node id',
  typeof dispatches[0]?.request?.prompt?.[0]?.text === 'string'
    && dispatches[0].request.prompt[0].text.includes(rootId),
)

// ── the tree is readable through the owner's tools ────────────────────────────
const listed = await tool('list_works').execute({}, { agent: owner })
check('list_works sees the tree', listed.ok === true && listed.summary.includes(rootId), listed.summary)

// The owner's list reports running/stuck, never how the engine distributed work internally.
check(
  'list_works stops at running/stuck and reports no per-state breakdown',
  listed.ok === true
    && listed.summary.includes('执行中')
    && !['待执行', '等待子工作', '已完成', '已失败'].some((word) => listed.summary.includes(word)),
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
const second = await tool('create_work').execute(
  { title: 'Second tree', description: 'Another unit of work', analysis: [] },
  { agent: owner },
)
check('second tree created without reopening the domain', second.ok === true, JSON.stringify(second))

// ── finish gate ──────────────────────────────────────────────────────────────
const early = await tool('finish_work').execute({ root_id: rootId }, { agent: owner })
check('finish refused while the root is unfinished', early.ok === false, JSON.stringify(early))

// ── the pre-step gate ────────────────────────────────────────────────────────
check('pre-step listener registered', preStepListeners.length === 1, `got ${String(preStepListeners.length)}`)

if (preStepListeners.length === 1) {
  const listener = preStepListeners[0]
  // The default the agent loop uses: the claimed inbox batch plus the runtime-context snapshot; a
  // stub returning `messages: []` could not show whether the hook preserves either.
  const user = { role: 'user', id: 'm1', content: [], source: { kind: 'user' } }
  const snapshot = { role: 'user', id: 's1', content: [], source: { kind: 'plugin', plugin: '@deepseek-ai/dsh-system-prompt', form: 'snapshot' } }
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

  // With work in hand the same wake must open a turn: the second tree's root is `ready` behind the
  // single worker slot, so this is work.
  const actionable = { agent: owner, messages: [wakeMessage], turn: 1, step: 1, signal: new AbortController().signal }
  const liveWake = await listener(actionable, enterWith([wakeMessage], snapshot))
  check(
    'engine wake opens a turn when a tree has work',
    liveWake.kind === 'enter' && (liveWake.messages?.length ?? 0) > 0,
    JSON.stringify(liveWake),
  )
}


// ── /work, creating mode (runs last: it adds a tree) ───────────────────────────
if (workCommand !== undefined) {
  const rooted = await workCommand.handler({ agent: owner, rawInput: ' Ship the migration ', commandId: 'c2', attachments: [], signal: new AbortController().signal })
  check('/work with text creates a root', rooted.kind === 'success' && /\[[0-9a-f]+\]/.test(rooted.text), rooted.text)
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
  const guide = promptSections.find((section) => section.name === 'avantf:work-tree-guide')
  check(
    'the seeded guidance file was left alone',
    readFileSync(join(promptDir, 'work-tree-guide.md'), 'utf8') === `${editedGuidance}\n`,
  )
  check(
    'a session that may not root a work still gets no guidance',
    guide?.text({ agent: { ...owner, id: 'outsider', header: { origin: 'subagent', delegationDepth: 1 }, session: { header: { origin: 'subagent', delegationDepth: 1 } } } }) === '',
  )
}

// ── teardown ─────────────────────────────────────────────────────────────────
await host.stop()
rmSync(scratch, { recursive: true, force: true })

if (failures.length > 0) {
  console.error(`\nMOUNT SMOKE FAILED (${String(failures.length)})`)
  for (const failure of failures) console.error(`  - ${failure}`)
  process.exit(1)
}
console.log('\nMOUNT SMOKE OK')
