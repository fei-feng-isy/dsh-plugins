#!/usr/bin/env node
/**
 * What the engine's workers actually do, read back from their sessions: a diagnostic, not a test.
 * The durable session records answer the policy questions — which tools workers reach for, how often
 * a dispatch fails, how many workers a node costs.
 *
 *   node scripts/worker-usage.mjs [--dir <sessions dir>] [--tree <root id>]   # read-only
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { zstdDecompressSync } from 'node:zlib'

/**
 * The claim-id predicate comes from the build, not from a copy: a second definition of the
 * format is how this script starts printing "worker sessions: 0" — a clean-looking answer — the
 * day the format changes.
 */
async function claimPredicate() {
  const built = fileURLToPath(new URL('../packages/plugin/lib/claims.js', import.meta.url))
  if (!existsSync(built)) {
    console.error('worker-usage: packages/plugin/lib/claims.js is missing — run `pnpm build:dsh` first')
    process.exit(1)
  }
  const module = await import(pathToFileURL(built).href)
  return (sessionId) => module.isWorkerClaimId(sessionId)
}

/** Session logs are zstd frames concatenated without a container, so scan for the magic. */
const FRAME_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])

/** Tools that mean "this worker tried to fan out or reach around the tree". */
const FAN_OUT = ['workflow', 'ralph', 'subagent', 'subagent_fork', 'send_message', 'job_output', 'job_kill']

const args = process.argv.slice(2)
const flag = (name) => {
  const at = args.indexOf(name)
  return at >= 0 ? args[at + 1] : undefined
}

/** The session directory for this workspace, or an explicit override. */
function sessionDir() {
  const explicit = flag('--dir')
  if (explicit !== undefined) return explicit
  const root = join(homedir(), '.dsh', 'sessions')
  if (!existsSync(root)) throw new Error(`no session store at ${root}`)
  // Matched on the workspace's own basename, not on a substring of the plugin's name: the
  // directory is derived from the workspace path, so a rename of either one has to break this
  // loudly rather than select a different project's sessions.
  const wanted = `--${basename(process.cwd()).replace(/[^A-Za-z0-9._-]/gu, '-')}--`
  const match = readdirSync(root).find((name) => name === wanted)
    ?? readdirSync(root).find((name) => name.includes(basename(process.cwd())))
  if (match === undefined) {
    throw new Error(`no session directory for ${process.cwd()} under ${root} (looked for ${wanted})`)
  }
  return join(root, match)
}

/** Decode one session log into its events. */
function load(path) {
  const raw = readFileSync(path)
  const parts = []
  let offset = 0
  while (true) {
    const at = raw.indexOf(FRAME_MAGIC, offset)
    if (at < 0) break
    try {
      parts.push(zstdDecompressSync(raw.subarray(at)))
    } catch {
      // A trailing partial frame is normal while a session is being written.
    }
    offset = at + 4
  }
  return Buffer.concat(parts)
    .toString('utf8')
    .trim()
    .split('\n')
    .map((line) => {
      try {
        return JSON.parse(line)
      } catch {
        return null
      }
    })
    .filter((event) => event !== null)
}

/**
 * The text of a tool result, for the failure line.
 *
 * The shape is nested: the message content holds the `tool-result` block, whose OWN
 * content array holds the text. Reading the outer level yields an empty error, which
 * makes the report look clean while failures sit in it.
 */
function resultText(message) {
  return (message?.content ?? [])
    .flatMap((block) => (block?.type === 'tool-result' ? (block.content ?? []) : [block]))
    .map((block) => (typeof block?.text === 'string' ? block.text : ''))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
}

const dir = sessionDir()
const wanted = flag('--tree')
const isOurWorker = await claimPredicate()
const sessions = readdirSync(dir).filter((name) => isOurWorker(name))
if (sessions.length === 0) {
  // Not "nothing to report": either no worker ran here, or the predicate no longer matches
  // what the plugin mints. The caller cannot tell those apart from an empty report.
  const total = readdirSync(dir).length
  console.error(`worker-usage: no mission sessions in ${dir} (${String(total)} session dir(s) there)`)
}
const usage = new Map()
const fanOut = []
const failures = []
let workers = 0

for (const name of sessions) {
  const path = join(dir, name, 'session.v3.jsonl.zstd')
  if (!existsSync(path)) continue
  const events = load(path)
  // The node id is the last id the worker's prompt carries (the chain lists ancestors first).
  const prompt = events
    .filter((event) => event.type === 'user/message')
    .map((event) => (event.data?.content ?? []).map((block) => block.text ?? '').join('\n'))
    .join('\n')
  const ids = [...prompt.matchAll(/id: ([0-9a-f]{8})/g)].map((match) => match[1])
  const node = ids.at(-1) ?? '?'
  if (wanted !== undefined && node !== wanted) continue
  workers += 1

  const calls = new Map()
  const seen = new Set()
  for (const event of events) {
    if (event.type === 'tool/call') {
      const tool = event.data?.name ?? event.data?.call?.name
      if (typeof tool !== 'string') continue
      calls.set(event.data?.callId ?? event.data?.id, tool)
      usage.set(tool, (usage.get(tool) ?? 0) + 1)
      // Fan-out per SESSION, not per call: the question is whether any worker reaches for it.
      if (FAN_OUT.includes(tool) && !seen.has(tool)) {
        seen.add(tool)
        fanOut.push({ session: name, node, tool })
      }
      continue
    }
    if (event.type !== 'tool/result') continue
    const block = event.data?.message?.content?.find?.((entry) => entry.type === 'tool-result')
    if (block?.isError !== true) continue
    failures.push({
      session: name,
      node,
      tool: calls.get(block.toolCallId) ?? '?',
      error: resultText(event.data?.message).slice(0, 160),
    })
  }
}

const width = Math.max(4, ...[...usage.keys()].map((key) => key.length))
console.log(`worker sessions: ${String(workers)} (in ${dir})`)
if (wanted !== undefined) console.log(`filtered to node: ${wanted}`)
console.log('\ntool usage:')
for (const [tool, count] of [...usage.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${tool.padEnd(width)}  ${String(count)}`)
}
console.log(`\nfan-out / reach-around attempts: ${String(fanOut.length)}`)
for (const entry of fanOut) console.log(`  ${entry.session}  node=${entry.node}  ${entry.tool}`)
console.log(`\nfailed tool calls: ${String(failures.length)}`)
for (const entry of failures) {
  console.log(`  ${entry.session}  node=${entry.node}  ${entry.tool}  ${entry.error}`)
}
if (process.argv.includes('--strict')) {
  const unknown = failures.filter((entry) => /unknown tool/.test(entry.error))
  if (unknown.length > 0) {
    console.error(`\n${String(unknown.length)} worker call(s) named a tool that does not exist — a prompt is out of date`)
    process.exit(1)
  }
}
