#!/usr/bin/env node
/**
 * Spike: does a parked continuable child actually COLD-RESUME?
 *
 * The one contract the continuation feature rests on: `ctx.subagents.sendMessage` for a
 * NON-resident child must walk `coldResume` → its persisted descriptor →
 * `authorizeLineage(owner, childId, child.parentSession)` → re-materialize the SAME session. The
 * plugin's own tests only reach the resident path, so this mounts the REAL
 * `@deepseek-ai/dsh-subagent` runtime, with stubs only at the three seams the manager reads:
 *
 *   - `agents`             — records create/resume; `resume` is the assertion target
 *   - `sessionPersistence` — existence check for a caller-reserved child id
 *   - `sessionQuery`       — the child's persisted header + events (what cold resume folds)
 *
 * No model turn is involved: the question is whether the resume path reaches the SAME session with
 * the owner as its authorizing parent.
 *
 * Run: node scripts/spike-cold-resume.mjs        (from the repo root)
 */
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

/**
 * Resolve the harness packages the way the LIVE profile does: the checkout has no
 * `@deepseek-ai/*` dependencies of its own, and dsh ships those packages inside its own install.
 */
function harnessPackage(name) {
  const profile = process.env['DSH_PROFILE_DIR'] ?? join(homedir(), '.dsh', 'profiles', 'web')
  const require = createRequire(join(profile, 'noop.js'))
  try {
    return require.resolve(name)
  } catch {
    // Last resort: the installed dsh's own bundled copy.
    return require.resolve(join(
      homedir(), '.npm-global', 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', name,
    ))
  }
}

const { Context } = await import(pathToFileURL(harnessPackage('@deepseek-ai/cordis')).href)
const subagent = await import(pathToFileURL(harnessPackage('@deepseek-ai/dsh-subagent')).href)

// ── the fake world ────────────────────────────────────────────────────────────────

// The DURABLE side: session logs survive a process (everything else is rebuilt by `bootstrap()`),
// so "run 1 creates, run 2 resumes" models a restart, not a same-context deletion.
const sessions = new Map()
let nextSeq = 0

/** Append one event the way a real session log does, stamping a monotonic seq. */
function append(record, type, data) {
  record.seq += 1
  record.events.push({ type, seq: record.seq, time: nextSeq += 1, data })
}

/** A session record shaped like what `coldResume` reads through `sessionQuery`. */
function session(id, parentSession) {
  const record = {
    id,
    parentSession,
    events: [],
    seq: 0,
    header: { id, parentSession, cwd: process.cwd() },
  }
  sessions.set(id, record)
  return record
}

// One process: a context, the real runtime, the services the manager reads, and a FRESH
// registry of live agents — run 2 starting with nobody live is the point.
async function bootstrap() {
  const live = new Map()
  const resumes = []
  const ctx = new Context()

  ctx.provide('agents', {
    get: (id) => live.get(id),
    list: () => [...live.values()],
    create: async (options) => {
      const record = session(options.sessionId, options.parentAgent?.id)
      const agent = agentStub(ctx, live, options.sessionId, record)
      live.set(options.sessionId, agent)
      await options.setup?.(childCtx(ctx), agent)
      return { agent }
    },
    resume: async (options) => {
      const record = sessions.get(options.resumeSessionId)
      resumes.push({
        resumeSessionId: options.resumeSessionId,
        parentAgent: options.parentAgent?.id,
        hadRecord: record !== undefined,
      })
      if (record === undefined) return undefined
      const agent = agentStub(ctx, live, options.resumeSessionId, record)
      live.set(options.resumeSessionId, agent)
      await options.setup?.(childCtx(ctx), agent)
      return { agent }
    },
  })

  ctx.provide('sessionPersistence', {
    stat: async (id) => sessions.get(id),
    list: async () => [...sessions.values()].map((record) => ({ header: record.header })),
  })

  ctx.provide('sessionQuery', {
    observeSession: async (id) => {
      const record = sessions.get(id)
      if (record === undefined) {
        const error = new Error(`session "${id}" not found`)
        error.code = 'SESSION_QUERY_SESSION_NOT_FOUND'
        throw error
      }
      return {
        header: record.header,
        events: record.events,
        inheritedEventCount: 0,
        [Symbol.dispose]: () => undefined,
      }
    },
  })

  ctx.provide('tools', { get: () => undefined })

  // `SubagentRuntime` arms its continuation manager via `ctx.inject(['agents', …])`; without
  // `sessionProjections` the callback never runs and `requireContinuations()` throws.
  ctx.provide('sessionProjections', { register: () => () => undefined })

  // Load the runtime as a PLUGIN, not by `new`-ing it: its constructor's `ctx.inject` callbacks
  // run in the plugin fiber's lifecycle.
  await ctx.plugin({ name: 'spike-subagents', apply: (pluginCtx) => { void new subagent.default(pluginCtx) } })

  const providerName = 'spike'
  ctx.subagents.registerProvider({
    name: providerName,
    prepareContinuable: () => Promise.resolve({}),
  })

  return { ctx, live, resumes, providerName }
}

/**
 * A child context for the manager's setup hook: `applyChildComposition` reads
 * `childCtx.systemPrompt` and `childCtx.tools` as SERVICES, so this must be a real scoped
 * context with those provided.
 */
function childCtx(ctx) {
  const child = ctx.isolate('tools').isolate('systemPrompt')
  child.provide('systemPrompt', {
    context: () => undefined,
    section: () => undefined,
    getContextOrder: () => 0,
    getSectionOrder: () => 0,
  })
  child.provide('tools', { restrict: () => undefined })
  return child
}

/**
 * An Agent-shaped stub carrying only the fields the manager reads: `session.header` feeds the
 * inherited child meta — absent `requestHeader()` means inheriting the parent's creation options —
 * and `subagentDepth` feeds `delegationDepthOf`.
 */
function agentStub(ctx, live, id, sessionRecord) {
  void live
  return {
    id,
    options: { subagentDepth: 0 },
    session: {
      header: { ...sessionRecord.header, id, delegationDepth: 0, cwd: process.cwd() },
      requestHeader: () => undefined,
      append: (type, data) => { append(sessionRecord, type, data) },
    },
    // The registry subscribes `agent/inbox/claimed` on this context to wake a parked activation.
    ctx: childCtx(ctx),
    inbox: { nextTurn: [], nextStep: [], closing: undefined },
    followup: () => undefined,
    steer: () => undefined,
    // The registry watches each activation's settlement through this; nothing settles in the spike.
    whenIdle: () => new Promise(() => undefined),
  }
}

// ── run 1: the owner delegates to a continuable child ────────────────────────────

const failures = []
const check = (label, condition, detail) => {
  if (condition) {
    console.log(`  ok   ${label}`)
    return true
  }
  console.log(`  FAIL ${label}${detail === undefined ? '' : `: ${detail}`}`)
  failures.push(label)
  return false
}

console.log('cold-resume spike (real @deepseek-ai/dsh-subagent; stub agents/persistence/query)')

const run1 = await bootstrap()
const ownerRecord = session('session-owner', null)
const owner = agentStub(run1.ctx, run1.live, 'session-owner', ownerRecord)
run1.live.set(owner.id, owner)

const childId = 'mission-spike01'
const started = await run1.ctx.subagents.startContinuable({
  provider: run1.providerName,
  label: 'mission spike01',
  childId,
  request: { prompt: [{ type: 'text', text: 'first prompt' }], parent: owner },
  signal: new AbortController().signal,
})
check('A1 startContinuable returned the reserved child id', started.childId === childId, String(started.childId))

const childRecord = sessions.get(childId)
check(
  'A2 the child session carries a subagent/descriptor event',
  childRecord?.events.some((event) => event.type === 'subagent/descriptor') === true,
  JSON.stringify(childRecord?.events.map((event) => event.type)),
)
const folded = childRecord === undefined ? undefined : subagent.foldSubagentDescriptor(childRecord.events)
check(
  'A3 the descriptor folds back as continuable',
  folded?.mode === 'continuable' && folded.provider === run1.providerName,
  JSON.stringify(folded),
)
check(
  'A4 the parent log records the child in its catalog',
  ownerRecord.events.some((event) => JSON.stringify(event.data ?? '').includes(childId)),
  JSON.stringify(ownerRecord.events.map((event) => event.type)),
)

// ── run 2: a fresh process. Nobody is live; only the session logs survive ────────
// The shape after a restart: the child id is on disk and the owner wants to continue it.

const run2 = await bootstrap()
const owner2Record = sessions.get('session-owner')
const owner2 = agentStub(run2.ctx, run2.live, 'session-owner', owner2Record)
run2.live.set(owner2.id, owner2)

let resumedMessageId
let resumeError
try {
  resumedMessageId = await run2.ctx.subagents.sendMessage(
    owner2,
    childId,
    [{ type: 'text', text: 'children are done; judge them' }],
    { signal: new AbortController().signal },
  )
} catch (error) {
  // Captured, not thrown: the spike reports the contract's outcome even when it fails.
  resumeError = error
}
check(
  'B1 sendMessage resolved with a message id',
  typeof resumedMessageId === 'string' && resumedMessageId.length > 0,
  resumeError === undefined ? String(resumedMessageId) : `${String(resumeError.code)}: ${resumeError.message}`,
)
check(
  'B2 cold resume re-materialized the SAME child session',
  run2.resumes.length === 1 && run2.resumes[0]?.resumeSessionId === childId,
  JSON.stringify(run2.resumes),
)
check(
  'B3 the authorizing parent was the owner session',
  run2.resumes[0]?.parentAgent === owner2.id,
  JSON.stringify(run2.resumes[0]),
)
check(
  'B4 the descriptor was found on the resumed session (not re-created)',
  run2.resumes[0]?.hadRecord === true,
  JSON.stringify(run2.resumes[0]),
)

// ── claim C: a sender that is not the recorded direct parent is refused ──────────

const strangerRecord = session('session-stranger', null)
const stranger = agentStub(run2.ctx, run2.live, 'session-stranger', strangerRecord)
run2.live.set(stranger.id, stranger)
let unauthorized
try {
  await run2.ctx.subagents.sendMessage(stranger, childId, [{ type: 'text', text: 'x' }], { signal: new AbortController().signal })
} catch (error) {
  unauthorized = error
}
check(
  'C  a non-parent sender is refused with UNAUTHORIZED',
  unauthorized?.code === 'UNAUTHORIZED',
  unauthorized === undefined ? 'no error thrown' : `${String(unauthorized.code)}: ${unauthorized.message}`,
)

// ── claim D: a one-shot child is not resumable ──────────────────────────────────

const oneShotId = 'session-oneshot'
const oneShotRecord = session(oneShotId, owner2.id)
append(oneShotRecord, 'subagent/descriptor', {
  version: 3,
  mode: 'one-shot',
  provider: run2.providerName,
  label: 'one-shot',
})
let notResumable
try {
  await run2.ctx.subagents.sendMessage(owner2, oneShotId, [{ type: 'text', text: 'x' }], { signal: new AbortController().signal })
} catch (error) {
  notResumable = error
}
check(
  'D  a one-shot child is refused with NOT_RESUMABLE',
  notResumable?.code === 'NOT_RESUMABLE',
  notResumable === undefined ? 'no error thrown' : `${String(notResumable.code)}: ${notResumable.message}`,
)

// ── verdict ─────────────────────────────────────────────────────────────────────

if (failures.length > 0) {
  console.error(`\nCOLD-RESUME SPIKE FAILED (${String(failures.length)}): ${failures.join(' | ')}`)
  process.exit(1)
}
console.log('\nCOLD-RESUME SPIKE OK — the proposal fast path is reachable on the real protocol')
// No agent loop settles the runtime's settlement watch; exiting here is the assertion, not a leak.
process.exit(0)
