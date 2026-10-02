/**
 * The persisted state plane: `<home>/.envinit/{.layout.json,status.json,declared.json}`.
 * @module state
 */
import { reasonOf } from './errors.js'
import { exists } from './fs.js'
import { decodeJson } from './manifest.js'
import { declaredPath, layoutPath, statusLockPath, statusPath } from './layout.js'
import { pidIsAlive } from './lock.js'
import type { Disposable, ProvisionFs, ProvisionLock, ProvisionLogger, ResourceSource } from './types.js'

/** `<home>/status.json` schema version. */
export const STATUS_SCHEMA_VERSION = 1
/** `<home>/.layout.json` schema version. */
export const LAYOUT_SCHEMA_VERSION = 1
/** How long a status write waits for the short lock. */
const STATUS_LOCK_TIMEOUT_MS = 5_000
/**
 * Must stay BELOW `STATUS_LOCK_TIMEOUT_MS`: it is both the reclaim age for a dead/undetectable
 * holder and the mtime age at which a waiter warns about a LIVE one. At `30_000` the waiter timed
 * out first, so that warning was unreachable (P15). Live holders are never reclaimed.
 */
const STATUS_LOCK_STALE_MS = 2_000
/** Declarations older than this, from a dead pid, are dropped. */
const DECLARED_TTL_MS = 7 * 24 * 60 * 60 * 1000

export interface LayoutFile {
  readonly schemaVersion: number
  readonly layout: string
  readonly writtenBy: string
}

/** One persisted status row; the identity is `key × version`. */
export interface StatusRow {
  readonly key: string
  readonly version: string
  readonly items: readonly string[]
  readonly plugins: readonly string[]
  readonly source?: ResourceSource
  readonly integrity?: string
  readonly updated_at: number
  readonly last_error?: { readonly code: string; readonly detail?: string; readonly retry_after?: number }
}

export interface StatusFile {
  readonly schemaVersion: number
  readonly rows: readonly StatusRow[]
}

export interface DeclaredEntry {
  readonly plugin: string
  readonly pid: number
  readonly at: number
}

export type DeclaredFile = Record<string, DeclaredEntry[]>

export type LayoutRead =
  | { readonly kind: 'ok'; readonly file: LayoutFile }
  | { readonly kind: 'none' }
  | { readonly kind: 'too-new' }
  | { readonly kind: 'mismatch'; readonly file: LayoutFile }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

/** Read `<home>/.layout.json` as ok, none, too-new or mismatch. */
export async function readLayout(fs: ProvisionFs, home: string, layout: string): Promise<LayoutRead> {
  const path = layoutPath(home)
  if (!(await exists(fs, path))) return { kind: 'none' }
  const raw = decodeJson(await fs.readFile(path))
  if (!isRecord(raw)) return { kind: 'none' }
  const schemaVersion = typeof raw['schemaVersion'] === 'number' ? raw['schemaVersion'] : LAYOUT_SCHEMA_VERSION
  const file: LayoutFile = {
    schemaVersion,
    layout: str(raw['layout']) ?? '',
    writtenBy: str(raw['writtenBy']) ?? '',
  }
  if (schemaVersion > LAYOUT_SCHEMA_VERSION) return { kind: 'too-new' }
  if (file.layout !== '' && file.layout !== layout) return { kind: 'mismatch', file }
  return { kind: 'ok', file }
}

/** Write the layout marker. */
export async function writeLayout(fs: ProvisionFs, home: string, layout: string, writtenBy: string): Promise<void> {
  const file: LayoutFile = { schemaVersion: LAYOUT_SCHEMA_VERSION, layout, writtenBy }
  await fs.atomicWrite(layoutPath(home), new TextEncoder().encode(`${JSON.stringify(file, null, 2)}\n`))
}

export type StatusRead =
  | { readonly kind: 'ok'; readonly rows: readonly StatusRow[] }
  | { readonly kind: 'none' }
  | { readonly kind: 'too-new' }
  | { readonly kind: 'unreadable' }

/** Read `status.json`; a newer schema yields `too-new`. */
export async function readStatus(fs: ProvisionFs, home: string): Promise<StatusRead> {
  const path = statusPath(home)
  if (!(await exists(fs, path))) return { kind: 'none' }
  const raw = decodeJson(await fs.readFile(path))
  if (!isRecord(raw)) return { kind: 'unreadable' }
  const schemaVersion = typeof raw['schemaVersion'] === 'number' ? raw['schemaVersion'] : 0
  if (schemaVersion > STATUS_SCHEMA_VERSION) return { kind: 'too-new' }
  const rows = Array.isArray(raw['rows']) ? raw['rows'] : []
  const parsed: StatusRow[] = []
  for (const row of rows) {
    if (!isRecord(row)) continue
    const key = str(row['key'])
    const version = typeof row['version'] === 'string' ? row['version'] : undefined
    if (key === undefined || version === undefined) continue
    const lastError = isRecord(row['last_error']) ? row['last_error'] : undefined
    const code = lastError === undefined ? undefined : str(lastError['code'])
    const detail = lastError === undefined ? undefined : str(lastError['detail'])
    const retryAfter = lastError === undefined ? undefined : lastError['retry_after']
    const source = str(row['source'])
    const integrity = str(row['integrity'])
    parsed.push({
      key,
      version,
      items: Array.isArray(row['items']) ? row['items'].filter((item): item is string => typeof item === 'string') : [],
      plugins: Array.isArray(row['plugins']) ? row['plugins'].filter((plugin): plugin is string => typeof plugin === 'string') : [],
      ...(source === undefined ? {} : { source: source as ResourceSource }),
      ...(integrity === undefined ? {} : { integrity }),
      updated_at: typeof row['updated_at'] === 'number' ? row['updated_at'] : 0,
      ...(code === undefined
        ? {}
        : {
            last_error: {
              code,
              ...(detail === undefined ? {} : { detail }),
              ...(typeof retryAfter === 'number' ? { retry_after: retryAfter } : {}),
            },
          }),
    })
  }
  return { kind: 'ok', rows: parsed }
}

/** Merge two row sets by `key × version`; newer `updated_at` wins, `items`/`plugins` are unioned. */
export function mergeRows(current: readonly StatusRow[], incoming: readonly StatusRow[]): readonly StatusRow[] {
  const merged = new Map<string, StatusRow>()
  for (const row of [...current, ...incoming]) {
    const id = `${row.key}\u0000${row.version}`
    const previous = merged.get(id)
    if (previous === undefined) {
      merged.set(id, row)
      continue
    }
    const winner = previous.updated_at >= row.updated_at ? previous : row
    const loser = winner === previous ? row : previous
    merged.set(id, {
      ...winner,
      items: [...new Set([...previous.items, ...row.items])].sort(),
      plugins: [...new Set([...previous.plugins, ...row.plugins])].sort(),
      ...(winner.source === undefined && loser.source !== undefined ? { source: loser.source } : {}),
      ...(winner.integrity === undefined && loser.integrity !== undefined ? { integrity: loser.integrity } : {}),
    })
  }
  // Fold a version-less row into the newest versioned row for the same key.
  const newestVersioned = new Map<string, string>()
  for (const [id, row] of merged) {
    if (row.version === '') continue
    const incumbentId = newestVersioned.get(row.key)
    const incumbent = incumbentId === undefined ? undefined : merged.get(incumbentId)
    if (incumbent === undefined || incumbent.updated_at < row.updated_at) newestVersioned.set(row.key, id)
  }
  for (const [id, row] of merged) {
    if (row.version !== '') continue
    const winnerId = newestVersioned.get(row.key)
    const winner = winnerId === undefined ? undefined : merged.get(winnerId)
    if (winnerId === undefined || winner === undefined || winner.updated_at < row.updated_at) continue
    // Fold the unresolved row into the versioned one, unioning `items` and `plugins`.
    merged.set(winnerId, {
      ...winner,
      items: [...new Set([...winner.items, ...row.items])].sort(),
      plugins: [...new Set([...winner.plugins, ...row.plugins])].sort(),
    })
    merged.delete(id)
  }
  return [...merged.values()]
}

async function withStatusLock<T>(lock: ProvisionLock, home: string, mission: () => Promise<T>): Promise<T> {
  const handle: Disposable = await lock.acquire(statusLockPath(home), {
    timeoutMs: STATUS_LOCK_TIMEOUT_MS,
    staleMs: STATUS_LOCK_STALE_MS,
  })
  try {
    return await mission()
  } finally {
    handle.dispose()
  }
}

/** Persist rows by read-modify-write under the status short lock; returns `ok`, `read-only` or `too-new`. */
export async function persistStatus(
  fs: ProvisionFs,
  lock: ProvisionLock,
  home: string,
  rows: readonly StatusRow[],
  logger: ProvisionLogger,
): Promise<'ok' | 'read-only' | 'too-new'> {
  try {
    return await withStatusLock(lock, home, async () => {
      const existing = await readStatus(fs, home)
      if (existing.kind === 'too-new') return 'too-new'
      const base = existing.kind === 'ok' ? existing.rows : []
      const merged = mergeRows(base, rows)
      const file: StatusFile = { schemaVersion: STATUS_SCHEMA_VERSION, rows: merged }
      await fs.atomicWrite(statusPath(home), new TextEncoder().encode(`${JSON.stringify(file, null, 2)}\n`))
      return 'ok'
    })
  } catch (error) {
    logger.warn(`state: could not persist status.json read-only: ${reasonOf(error).message}`)
    return 'read-only'
  }
}

/** Read the declared registry, tolerating every failure as "empty". */
export async function readDeclared(fs: ProvisionFs, home: string): Promise<DeclaredFile> {
  const path = declaredPath(home)
  if (!(await exists(fs, path))) return {}
  const raw = decodeJson(await fs.readFile(path))
  if (!isRecord(raw)) return {}
  const file: DeclaredFile = {}
  const now = Date.now()
  for (const [key, value] of Object.entries(raw)) {
    if (!Array.isArray(value)) continue
    const entries: DeclaredEntry[] = []
    for (const entry of value) {
      if (!isRecord(entry)) continue
      const plugin = str(entry['plugin'])
      const pid = typeof entry['pid'] === 'number' ? entry['pid'] : undefined
      const at = typeof entry['at'] === 'number' ? entry['at'] : 0
      if (plugin === undefined || pid === undefined) continue
      // Drop entries that are stale or whose pid is gone.
      const stale = now - at > DECLARED_TTL_MS
      if (stale || !pidIsAlive(pid)) continue
      entries.push({ plugin, pid, at })
    }
    if (entries.length > 0) file[key] = entries
  }
  return file
}

/** Append one declaration for `key`, merging with what is already on disk. */
export async function recordDeclared(
  fs: ProvisionFs,
  lock: ProvisionLock,
  home: string,
  key: string,
  plugin: string,
  logger: ProvisionLogger,
): Promise<void> {
  try {
    await withStatusLock(lock, home, async () => {
      const file = await readDeclared(fs, home)
      const entries = file[key] ?? []
      if (!entries.some(entry => entry.plugin === plugin && entry.pid === process.pid)) {
        entries.push({ plugin, pid: process.pid, at: Date.now() })
      }
      file[key] = entries
      await fs.atomicWrite(declaredPath(home), new TextEncoder().encode(`${JSON.stringify(file, null, 2)}\n`))
    })
  } catch (error) {
    logger.warn(`state: could not record the declaration for ${key}: ${reasonOf(error).message}`)
  }
}
