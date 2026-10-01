#!/usr/bin/env node
/**
 * Diagnose (and optionally repair) the durable workspace registry document.
 *
 * `WorkspaceRegistry.validateStoredState` refuses to start when the registry is self-inconsistent:
 * every duplicate path, repeated or missing order entry, and doubly-accounted session is a FATAL
 * load failure that nothing in dsh repairs, so it is a manual JSON edit unless this script does it.
 *
 * The rules below transcribe that validator, using the SHIPPED schemas imported from whichever
 * `@deepseek-ai/dsh-workspace` this checkout resolves.
 *
 *   node scripts/workspace-doctor.mjs [--file <path>] [--fix]
 *
 * `--fix` and its backup are the only writes; by default this script is read-only.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

/** Resolve the declared schemas from the dsh install, wherever this checkout keeps it. */
async function loadSchemas() {
  const failures = []
  for (const candidate of candidateModules()) {
    try {
      const module = await import(candidate)
      if (module.workspaceDomainState && module.workspaceRecord) return module
      failures.push(`${candidate}: module carries no workspace schemas`)
    } catch (error) {
      failures.push(`${candidate}: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  throw new Error(`cannot resolve @deepseek-ai/dsh-workspace:\n  ${failures.join('\n  ')}`)
}

/**
 * Every place the workspace package may sit, nearest first: the profile's own `node_modules` does
 * not carry it — dsh ships those packages inside the install named by the `dsh` binary on PATH.
 *
 * @returns import specifiers, in the order they should be tried.
 */
function candidateModules() {
  const candidates = ['@deepseek-ai/dsh-workspace']
  const bin = whichDsh()
  if (bin !== undefined) {
    // `<prefix>/bin/dsh` → `<prefix>/lib/node_modules/@deepseek-ai/dsh/…` (npm global).
    const root = resolve(bin, '..', '..')
    for (const install of [
      join(root, 'lib', 'node_modules', '@deepseek-ai', 'dsh'),
      join(root, 'node_modules', '@deepseek-ai', 'dsh'),
    ]) {
      candidates.push(pathToFileURL(join(install, 'node_modules', '@deepseek-ai', 'dsh-workspace', 'lib', 'index.js')).href)
    }
  }
  const home = process.env['DSH_HOME'] ?? join(homedir(), '.dsh')
  candidates.push(pathToFileURL(join(home, 'profiles', 'web', 'node_modules', '@deepseek-ai', 'dsh-workspace', 'lib', 'index.js')).href)
  return candidates
}

/** The `dsh` executable on PATH, when there is one. */
function whichDsh() {
  for (const dir of (process.env['PATH'] ?? '').split(':')) {
    if (dir === '') continue
    const candidate = join(dir, 'dsh')
    if (existsSync(candidate)) return candidate
  }
}

/** The default document: the JSON storage backend's `workspace` unit under the dsh home. */
function defaultFile() {
  const home = process.env['DSH_HOME'] ?? join(homedir(), '.dsh')
  return join(home, 'storages', 'workspace.json')
}

/** Local `YYYYMMDD-HHmmss`, matching the backend's own backup naming. */
function stamp(now = new Date()) {
  const pad = (value) => String(value).padStart(2, '0')
  return `${String(now.getFullYear())}${pad(now.getMonth() + 1)}${pad(now.getDate())}`
    + `-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`
}

/** Resolve the document path from argv, or the default. */
function resolveFile(argv) {
  const at = argv.indexOf('--file')
  if (at === -1) return defaultFile()
  const value = argv[at + 1]
  if (value === undefined || value.startsWith('--')) throw new Error('--file needs a path')
  return resolve(value)
}

/**
 * The `validateStoredState` rules, in their own order, as a list of objections; unlike the
 * validator it reports ALL of them, because a repair needs the whole picture.
 *
 * @returns one line per inconsistency.
 */
function inspect(state, records) {
  const problems = []
  const order = new Set()
  for (const id of state.workspaceIds) {
    if (order.has(id)) problems.push(`registry order repeats workspace '${id}'`)
    if (!records.has(id)) problems.push(`registry order references missing workspace '${id}'`)
    order.add(id)
  }
  if (state.initialized && order.size !== records.size) {
    const orphan = [...records.keys()].find((id) => !order.has(id))
    problems.push(`workspace '${orphan}' is absent from registry order`)
  }
  const paths = new Map()
  const accounted = new Map()
  for (const [id, record] of records) {
    const holder = paths.get(record.path)
    if (holder !== undefined) {
      problems.push(`path '${record.path}' is claimed by both workspace '${holder}' and workspace '${id}'`)
    } else {
      paths.set(record.path, id)
    }
    for (const sessionId of record.sessionIds) {
      const other = accounted.get(sessionId)
      if (other !== undefined && other !== id) {
        problems.push(`session '${sessionId}' is accounted by both workspace '${other}' and workspace '${id}'`)
      } else {
        accounted.set(sessionId, id)
      }
    }
  }
  return problems
}

/**
 * Repair the two inconsistencies that CAN be repaired without guessing which record the user
 * meant: a duplicate path and the doubly-accounted session it usually carries. Order duplicates
 * and missing records are left alone — those mean the document lost data, and inventing a record
 * is worse than refusing to start.
 *
 * @param state - the parsed global slot (not mutated).
 * @param records - every workspace record, keyed by id (not mutated).
 * @returns the repaired `{ state, records, changes }`.
 */
function repair(state, records) {
  const next = new Map([...records].map(([id, record]) => [id, { ...record, sessionIds: [...record.sessionIds] }]))
  const changes = []
  const byPath = new Map()
  for (const [id, record] of next) {
    const keeper = byPath.get(record.path)
    if (keeper === undefined) {
      byPath.set(record.path, id)
      continue
    }
    const keeperRecord = next.get(keeper)
    // Keep the record that accounts for more sessions; ties break on the earlier
    // creation, because the later one is the accidental duplicate.
    const duplicateWins = keeperRecord.sessionIds.length < record.sessionIds.length
      || (keeperRecord.sessionIds.length === record.sessionIds.length
        && Date.parse(record.createdAt) < Date.parse(keeperRecord.createdAt))
    const [survivorId, doomedId] = duplicateWins ? [id, keeper] : [keeper, id]
    const survivor = next.get(survivorId)
    const doomed = next.get(doomedId)
    for (const sessionId of doomed.sessionIds) {
      if (!survivor.sessionIds.includes(sessionId)) survivor.sessionIds.unshift(sessionId)
    }
    next.delete(doomedId)
    byPath.set(record.path, survivorId)
    changes.push(
      `path '${record.path}': merged workspace '${doomedId}' into '${survivorId}'`
      + ` (${String(doomed.sessionIds.length)} session(s) moved, record and order entry dropped)`,
    )
  }
  // A session can still be accounted twice across DIFFERENT paths (a record created
  // for one directory holding another's session). First account wins; the later
  // membership is dropped.
  const accounted = new Map()
  for (const [id, record] of next) {
    const kept = []
    for (const sessionId of record.sessionIds) {
      const other = accounted.get(sessionId)
      if (other === undefined || other === id) {
        accounted.set(sessionId, id)
        kept.push(sessionId)
      } else {
        changes.push(`session '${sessionId}': dropped from workspace '${id}' (already accounted by '${other}')`)
      }
    }
    record.sessionIds = kept
  }
  const workspaceIds = state.workspaceIds.filter((id) => next.has(id))
  if (workspaceIds.length !== state.workspaceIds.length) {
    for (const id of state.workspaceIds) if (!next.has(id)) changes.push(`registry order: dropped '${id}'`)
  }
  return { state: { ...state, workspaceIds }, records: next, changes }
}

/** Render the document the JSON backend expects: unit header, global, one table. */
function serialize(document, state, records) {
  return `${JSON.stringify({
    unit: document.unit,
    global: state,
    tables: { workspaces: Object.fromEntries(records) },
  }, null, 2)}\n`
}

const argv = process.argv.slice(2)
const file = resolveFile(argv)
const fix = argv.includes('--fix')

const { workspaceDomainState, workspaceRecord } = await loadSchemas()
if (!existsSync(file)) {
  console.error(`workspace-doctor: no such document: ${file}`)
  process.exit(2)
}
const document = JSON.parse(readFileSync(file, 'utf8'))
if (document.tables?.workspaces === undefined) {
  console.error(`workspace-doctor: ${file} carries no 'workspaces' table (unit '${document.unit?.name ?? '?'}')`)
  process.exit(2)
}

// Parse first, as the domain does on open: a record failing its schema is a different failure.
const state = workspaceDomainState.parse(document.global)
const records = new Map()
for (const [id, raw] of Object.entries(document.tables.workspaces)) {
  records.set(id, workspaceRecord.parse(raw))
}

const problems = inspect(state, records)
console.log(`workspace-doctor: ${file}`)
console.log(`  ${String(records.size)} workspace record(s), ${String(state.workspaceIds.length)} order entry(ies)`)
for (const [id, record] of records) {
  console.log(`    ${id}  ${record.path}  (${String(record.sessionIds.length)} session(s))`)
}

if (problems.length === 0) {
  console.log('  ok: consistent — dsh can open this document')
  process.exit(0)
}

console.log(`  ${String(problems.length)} inconsistency(ies) — dsh will refuse to start:`)
for (const problem of problems) console.log(`    - workspace domain is inconsistent: ${problem}`)

if (!fix) {
  console.log('\n  re-run with --fix to write the repaired document (a backup is written first)')
  process.exit(1)
}

const repaired = repair(state, records)
if (repaired.changes.length === 0) {
  console.log('\n  --fix: nothing this script can repair without guessing; the document is unchanged')
  process.exit(1)
}
const backup = `${file}.bak-${stamp()}`
writeFileSync(backup, readFileSync(file))
writeFileSync(file, serialize(document, repaired.state, repaired.records))
console.log(`\n  --fix: backup written to ${backup}`)
for (const change of repaired.changes) console.log(`    - ${change}`)
const remaining = inspect(repaired.state, repaired.records)
if (remaining.length > 0) {
  console.log(`  still inconsistent after repair (${String(remaining.length)}); this needs a human decision:`)
  for (const problem of remaining) console.log(`    - ${problem}`)
  process.exit(1)
}
console.log('  repaired: consistent — the next dsh boot can open this document')
